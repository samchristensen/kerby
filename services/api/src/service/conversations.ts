import type { ContentPart } from "@kerby/agent";
import type {
  Conversation,
  CreateConversationRequest,
  EventEnvelope,
  GetConversationQuery,
  GetConversationResponse,
  PostMessageRequest,
  PostMessageResponse,
} from "@kerby/contracts";
import { PublicMessageSchema, parseModelId } from "@kerby/contracts";
import { hasModelKey } from "@kerby/control-plane";
import {
  ConversationNotFoundError,
  conversationChannel,
  findConversation,
  insertConversation,
  isBusy,
  parseNotice,
  postUserMessage,
  readMessages,
  type StoredMessage,
} from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import { errorFields, log } from "@kerby/observability";
import { type ApiDeps, NotFoundError } from "../types/index.ts";

export class InvalidModelError extends Error {
  override name = "InvalidModelError";
}

function conversationResource(record: {
  id: string;
  externalUserId: string | null;
  model: string;
  system: string;
  createdAt: Date;
}): Conversation {
  return {
    id: record.id,
    externalUserId: record.externalUserId,
    model: record.model,
    system: record.system,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function createConversation(
  deps: ApiDeps,
  ctx: TenantContext,
  request: CreateConversationRequest,
): Promise<Conversation> {
  const model = request.model ?? deps.settings.defaultModel;
  if (!model) throw new InvalidModelError("model is required: <provider>/<modelId>");
  const parsed = parseModelId(model);
  if (!parsed) throw new InvalidModelError(`model "${model}" must look like <provider>/<modelId>`);
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
  const record = await insertConversation(ctx.db, {
    externalUserId: request.externalUserId,
    model,
    system: request.system ?? deps.settings.defaultSystem,
  });
  return conversationResource(record);
}

const asParts = (content: PostMessageRequest["content"]): ContentPart[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

/**
 * Append the message, enqueue its turn, and tell the workers there is work for this tenant. Refused when the tenant's
 * stored bytes, with this message, would pass `storageBytes`.
 */
export async function postMessage(
  deps: ApiDeps,
  ctx: TenantContext,
  conversationId: string,
  request: PostMessageRequest,
  storageBytes: number,
): Promise<PostMessageResponse> {
  if (!(await findConversation(ctx.db, conversationId)))
    throw new NotFoundError("conversation not found");
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
  // At-least-once: the worker's periodic sweep finds the turn even if this notification is lost.
  await deps.control
    .query("select pg_notify('tenant_work', $1)", [ctx.tenantId])
    .catch((error: unknown) => {
      log("warn", "could not notify workers; the sweep will find the turn", errorFields(error));
    });
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
  conversationId: string,
  page: GetConversationQuery,
): Promise<GetConversationResponse> {
  const record = await findConversation(ctx.db, conversationId);
  if (!record) throw new NotFoundError("conversation not found");
  const [{ messages, nextAfter }, busy] = await Promise.all([
    readMessages(ctx, deps.blobs, conversationId, page),
    isBusy(ctx.db, conversationId),
  ]);
  return {
    conversation: conversationResource(record),
    messages: messages.map(toPublic),
    nextAfter,
    busy,
    lastError: record.lastError,
  };
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
 * `db` must stay leased for the whole iteration.
 */
export async function* conversationEvents(
  deps: ApiDeps,
  ctx: TenantContext,
  conversationId: string,
  afterSeq: number,
  signal: AbortSignal,
  stillAllowed: () => Promise<boolean>,
): AsyncGenerator<StreamItem> {
  if (!(await findConversation(ctx.db, conversationId)))
    throw new NotFoundError("conversation not found");

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
      else live.push(notice.live);
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
