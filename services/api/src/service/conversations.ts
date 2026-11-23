import type { ContentPart } from "@kerby/agent";
import type {
  Conversation,
  CreateConversationRequest,
  EventEnvelope,
  GetConversationQuery,
  GetConversationResponse,
  GetTraceQuery,
  GetTraceResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  PostMessageRequest,
  PostMessageResponse,
  StreamInclude,
  Visibility,
} from "@kerby/contracts";
import { DEFAULT_JUDGMENT_MODEL, PublicMessageSchema, parseModelId } from "@kerby/contracts";
import { hasModelKey, hintTenantWork } from "@kerby/control-plane";
import {
  ConversationNotFoundError,
  conversationChannel,
  findConversation,
  insertConversationInTx,
  isBusy,
  listConversations,
  parseNotice,
  postUserMessage,
  readMessages,
  readTrace,
  type StoredMessage,
} from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import { announceEvents, notifyDispatchers } from "@kerby/events";
import { errorFields, log } from "@kerby/observability";
import { listConversationTools, setConversationTools, toolPatterns } from "@kerby/tools";
import { type ApiDeps, NotFoundError, type Principal } from "../types/index.ts";
import { assertJudgmentModel, InvalidModelError } from "./models.ts";
import { renderChatPrompt } from "./prompts.ts";
import { assertHolds, conversationToolRefs, holdsEveryTool } from "./tools.ts";

function conversationResource(
  record: {
    id: string;
    externalUserId: string | null;
    integrationId: string | null;
    model: string;
    system: string;
    title: string | null;
    createdAt: Date;
    updatedAt: Date;
    guardrails: Conversation["guardrails"];
    prompt: Conversation["prompt"];
  },
  tools: string[],
): Conversation {
  return {
    id: record.id,
    externalUserId: record.externalUserId,
    integrationId: record.integrationId,
    model: record.model,
    system: record.system,
    title: record.title,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    guardrails: record.guardrails,
    prompt: record.prompt,
    tools,
  };
}

/** The conversations `visibility` sees, however they began, most recently active first. */
export async function listTenantConversations(
  ctx: TenantContext,
  query: ListConversationsQuery,
  visibility: Visibility,
): Promise<ListConversationsResponse> {
  const page = await listConversations(ctx.db, query, visibility);
  return {
    conversations: page.conversations.map((record) => ({
      id: record.id,
      externalUserId: record.externalUserId,
      integrationId: record.integrationId,
      model: record.model,
      title: record.title,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      messageCount: record.messageCount,
      prompt: record.prompt,
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * A conversation with the request's system prompt, model and guardrails, or those of a published chat prompt: its
 * label is resolved once, here, and the conversation keeps the rendered text and the version it came from (ADR 0017).
 * It is attributed to `integrationId` (null: a person in the console), which decides who sees it (ADR 0020).
 */
export async function createConversation(
  deps: ApiDeps,
  ctx: TenantContext,
  principal: Principal,
  request: CreateConversationRequest,
): Promise<Conversation> {
  const fromPrompt = request.prompt && (await renderChatPrompt(ctx, request.prompt));
  const model = (fromPrompt ? fromPrompt.model : request.model) ?? deps.settings.defaultModel;
  if (!model) throw new InvalidModelError("model is required: <provider>/<modelId>");
  const parsed = parseModelId(model);
  if (!parsed) throw new InvalidModelError(`model "${model}" must look like <provider>/<modelId>`);
  // A provider that only runs judgments holds a key but answers no chat: say so now, not at the first turn. (One that
  // does both, like OpenCode, is a chat provider too.)
  if (
    deps.settings.judgmentProviders.includes(parsed.provider) &&
    !deps.settings.modelProviders.includes(parsed.provider)
  )
    throw new InvalidModelError(
      `"${parsed.provider}" runs judgments, not conversations: use POST /v1/judgments`,
    );
  // Bring your own key: a conversation needs the tenant's key for its provider, so a missing one fails here and
  // not on the first turn.
  if (
    !deps.settings.keylessProviders.includes(parsed.provider) &&
    !(await hasModelKey(deps.control, ctx.tenantId, parsed.provider))
  ) {
    throw new InvalidModelError(
      `no model key for provider "${parsed.provider}": PUT /v1/model-keys/${parsed.provider} first`,
    );
  }
  // Guardrails are judgments: each runs on the tenant's key for its judgment model, and fails closed without it.
  const guardrails = fromPrompt?.guardrails ?? request.guardrails ?? [];
  for (const model of new Set(guardrails.map((g) => g.model ?? DEFAULT_JUDGMENT_MODEL)))
    await assertJudgmentModel(deps, ctx.tenantId, model);
  // Tools are named, never implied: resolved to server ids now, checked against the caller's grants, and stored with
  // the conversation in one transaction.
  const patterns = fromPrompt?.tools ?? request.tools ?? [];
  const conversation = await ctx.db.transaction(async (tx) => {
    const refs = await conversationToolRefs(deps, tx, ctx.tenantId, principal, patterns);
    const record = await insertConversationInTx(tx, {
      integrationId: principal.integrationId,
      externalUserId: request.externalUserId,
      model,
      system: fromPrompt?.text ?? request.system ?? deps.settings.defaultSystem,
      guardrails,
      prompt: fromPrompt && { name: fromPrompt.name, version: fromPrompt.version },
    });
    await setConversationTools(tx, record.id, refs);
    return conversationResource(record, await toolPatterns(tx, refs));
  });
  // Its `conversation.created` event committed with it.
  await announceEvents(ctx.db);
  await notifyDispatchers(deps.control, ctx.tenantId);
  return conversation;
}

const asParts = (content: PostMessageRequest["content"]): ContentPart[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * Append the message, enqueue its turn, and tell the workers there is work for this tenant (and the dispatchers there is
 * an event). Refused when the tenant's stored bytes, with this message, would pass `storageBytes`, or when the caller does
 * not hold every tool the conversation names (so an integration cannot push a conversation it sees into tools it was
 * not given).
 */
export async function postMessage(
  deps: ApiDeps,
  ctx: TenantContext,
  principal: Principal,
  conversationId: string,
  request: PostMessageRequest,
  storageBytes: number,
): Promise<PostMessageResponse> {
  if (!(await findConversation(ctx.db, conversationId, principal.visibility)))
    throw new NotFoundError("conversation not found");
  if (!holdsEveryTool(principal))
    await assertHolds(ctx.db, principal, await listConversationTools(ctx.db, conversationId));
  let seq: number;
  try {
    ({ seq } = await postUserMessage(ctx, deps.blobs, conversationId, asParts(request.content), {
      storageBytes,
    }));
  } catch (error) {
    if (error instanceof ConversationNotFoundError)
      throw new NotFoundError("conversation not found");
    throw error;
  }
  // After the commit, so a worker that sees the hint can claim the turn. At-least-once: if the hint is lost, the
  // worker's full sweep finds the turn.
  await hintTenantWork(deps.control, ctx.tenantId).catch((error: unknown) => {
    log("warn", "could not hint workers; the full sweep will find the turn", errorFields(error));
  });
  await notifyDispatchers(deps.control, ctx.tenantId);
  return { seq };
}

const toPublic = (message: StoredMessage) => ({
  seq: message.seq,
  // Parsing strips the harness's `native` payload: it stays inside Kerby.
  message: PublicMessageSchema.parse(message.message),
  createdAt: message.createdAt.toISOString(),
});

export async function getConversation(
  deps: ApiDeps,
  ctx: TenantContext,
  visibility: Visibility,
  conversationId: string,
  page: GetConversationQuery,
): Promise<GetConversationResponse> {
  const record = await findConversation(ctx.db, conversationId, visibility);
  if (!record) throw new NotFoundError("conversation not found");
  const [{ messages, nextAfter }, busy] = await Promise.all([
    readMessages(ctx, deps.blobs, conversationId, page),
    isBusy(ctx.db, conversationId),
  ]);
  const tools = await toolPatterns(ctx.db, await listConversationTools(ctx.db, conversationId));
  return {
    conversation: conversationResource(record, tools),
    messages: messages.map(toPublic),
    nextAfter,
    busy,
    lastError: record.lastError,
  };
}

/** The conversation's trace: everything its runs reported, in the order it was recorded (ADR 0018). */
export async function getTrace(
  deps: ApiDeps,
  ctx: TenantContext,
  visibility: Visibility,
  conversationId: string,
  page: GetTraceQuery,
): Promise<GetTraceResponse> {
  if (!(await findConversation(ctx.db, conversationId, visibility)))
    throw new NotFoundError("conversation not found");
  const { entries, nextAfter } = await readTrace(ctx, deps.blobs, conversationId, page);
  return { events: entries, nextAfter };
}

/** One item of a conversation's event stream. `id` is set only for persisted messages, which can be replayed. */
export type StreamItem = { id?: number; envelope: EventEnvelope } | { keepAlive: true };

const KEEP_ALIVE_MS = 15_000;
/** Backstop for a lost NOTIFY: look at the index at least this often. */
const POLL_MS = 5_000;
/** Messages read per page while replaying. */
const REPLAY_PAGE = 100;

/**
 * The conversation's events: persisted messages after `afterSeq` (replayed from the index), then live as they
 * happen. LISTEN is established before the replay reads, so nothing falls between them. Ends when `signal` aborts.
 * The model's reasoning (`thinking_*`) is live only, and only for a stream that asked for it (`include`): by default
 * the stream is as it was before a harness exposed any. `db` must stay leased for the whole iteration.
 */
export async function* conversationEvents(
  deps: ApiDeps,
  ctx: TenantContext,
  visibility: Visibility,
  conversationId: string,
  afterSeq: number,
  include: readonly StreamInclude[],
  signal: AbortSignal,
  stillAllowed: () => Promise<boolean>,
): AsyncGenerator<StreamItem> {
  if (!(await findConversation(ctx.db, conversationId, visibility)))
    throw new NotFoundError("conversation not found");

  const wantsThinking = include.includes("thinking");
  let wake = Promise.withResolvers<void>();
  let dirty = true; // replay first
  const live: EventEnvelope[] = [];
  const poke = () => wake.resolve();
  const subscription = await ctx.db.listen(
    conversationChannel(conversationId),
    (payload) => {
      const notice = parseNotice(payload);
      if (!notice) return;
      if ("persisted" in notice) dirty = true;
      else if (
        wantsThinking ||
        (notice.live.event.type !== "thinking_delta" && notice.live.event.type !== "thinking_end")
      )
        live.push(notice.live);
      poke();
    },
    {
      onReconnect: () => {
        dirty = true;
        poke();
      },
    },
  );
  const onAbort = () => poke();
  signal.addEventListener("abort", onAbort, { once: true });

  let lastSeq = afterSeq;
  let lastActivity = Date.now();
  let lastPoll = 0;
  let lastCheck = Date.now();
  try {
    while (!signal.aborted) {
      // Ends the stream when the key was revoked or the tenant suspended since it opened.
      if (Date.now() - lastCheck >= deps.settings.streamRecheckMs) {
        lastCheck = Date.now();
        if (!(await stillAllowed())) return;
      }
      if (dirty || Date.now() - lastPoll >= POLL_MS) {
        dirty = false;
        lastPoll = Date.now();
        // A page at a time, so a long conversation's replay never holds more than one page of bodies.
        let more = true;
        while (more && !signal.aborted) {
          const page = await readMessages(ctx, deps.blobs, conversationId, {
            after: lastSeq,
            limit: REPLAY_PAGE,
          });
          more = page.nextAfter !== null;
          for (const stored of page.messages) {
            lastSeq = stored.seq;
            lastActivity = Date.now();
            yield {
              id: stored.seq,
              envelope: {
                v: 1,
                conversationId,
                runId: stored.runId ?? "",
                seq: stored.seq,
                at: stored.createdAt.toISOString(),
                // Public form: the harness's native payload is not for clients.
                event: { type: "message_end", message: PublicMessageSchema.parse(stored.message) },
              },
            };
          }
        }
      }
      while (live.length > 0) {
        const envelope = live.shift();
        if (envelope) {
          lastActivity = Date.now();
          yield { envelope };
        }
      }
      if (Date.now() - lastActivity >= KEEP_ALIVE_MS) {
        lastActivity = Date.now();
        yield { keepAlive: true };
      }
      wake = Promise.withResolvers<void>();
      if (dirty || live.length > 0 || signal.aborted) continue;
      const timer = setTimeout(
        poke,
        Math.min(POLL_MS, KEEP_ALIVE_MS, deps.settings.streamRecheckMs),
      );
      await wake.promise;
      clearTimeout(timer);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await subscription.close();
  }
}
