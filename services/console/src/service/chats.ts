// Chatting from the browser and browsing every conversation of the tenant, however it began. The data lives in the
// tenant's own database behind the api, which enforces its limits and quotas; the console reaches it with the person's
// session token, so the tenant is always the one the person belongs to (ADR 0014).
import {
  CreateConversationRequestSchema,
  GetConversationResponseSchema,
  ListConversationsResponseSchema,
  parseModelId,
} from "@kerby/contracts";
import { hasModelKey } from "@kerby/control-plane";
import { z } from "zod";
import type {
  ChatAccess,
  ChatListView,
  ChatOrigin,
  ChatStatus,
  ChatView,
  ConsoleDeps,
  FormFailure,
  FormInput,
} from "../types/index.ts";
import { parseForm, refuse } from "./forms.ts";

/** A conversation the console starts carries this end-user name, so the list can tell it from the tenant's own code's. */
const CONSOLE_USER_PREFIX = "console:";

const CHATS_PER_PAGE = 40;
/** The api's page limit for messages: a conversation is read in as few requests as it allows. */
const MESSAGES_PER_PAGE = 500;
/** Past every message a conversation can hold: a read after it returns no messages, only whether a turn is running. */
const PAST_THE_LAST_MESSAGE = 2_147_483_647;

const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const originOf = (externalUserId: string | null): ChatOrigin =>
  externalUserId?.startsWith(CONSOLE_USER_PREFIX) ? "console" : "api";

const MessageField = z
  .string()
  .min(1, "write a message first")
  .max(1_000_000, "at most 1 000 000 characters");

const CreateChatForm = z.object({
  message: MessageField,
  model: z.string().trim().max(200, "at most 200 characters").default(""),
  system: z.string().max(100_000, "at most 100 000 characters").default(""),
});

const SendForm = z.object({ message: MessageField });

/** A message typed in a form: trimmed, so a blank one is refused as empty. */
const trimmedMessage = (form: FormInput): FormInput => ({
  ...form,
  message: typeof form.message === "string" ? form.message.trim() : form.message,
});

/** What the person is told when the api refuses a post. A fault on our side (5xx, a bad credential) is thrown instead. */
async function refusal(response: Response): Promise<FormFailure> {
  const body = ErrorBodySchema.safeParse(await response.json().catch(() => null));
  const code = body.data?.error.code;
  switch (code) {
    case "conversation_busy":
      return refuse("A reply is still being written. Wait for it to finish.");
    case "conversation_full":
      return refuse("This conversation is full. Start a new chat.");
    case "not_found":
      return refuse("This conversation no longer exists.");
    case "rate_limited":
      return refuse("Too many requests. Try again in a moment.");
    case "storage_quota_exceeded":
    case "invalid_model":
      return refuse(body.data?.error.message ?? "The request was refused.");
  }
  throw new Error(
    `the api refused a chat request: ${response.status} ${code ?? "(no error code)"}`,
  );
}

type ConversationPage = z.output<typeof GetConversationResponseSchema>;

export function createChats(deps: ConsoleDeps) {
  const { api, control, settings } = deps;

  /** The api's answer, or undefined for "not found"; anything else that is not success (an expired credential, an outage) throws. */
  async function read(access: ChatAccess, path: string): Promise<Response | undefined> {
    const response = await api({ method: "GET", path, token: access.token });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`the api refused a chat read: ${response.status}`);
    return response;
  }

  /** A conversation id goes into a path: only a uuid is let through. */
  const isId = (id: string) => z.uuid().safeParse(id).success;

  return {
    async chats(access: ChatAccess, cursor?: string): Promise<ChatListView> {
      const query = new URLSearchParams({ limit: String(CHATS_PER_PAGE) });
      if (cursor) query.set("cursor", cursor);
      const response = await api({
        method: "GET",
        path: `/v1/conversations?${query}`,
        token: access.token,
      });
      // A cursor the api does not know (the page was kept open across a deploy) ends the list instead of failing it.
      if (response.status === 400 && cursor) return { chats: [], nextCursor: null };
      if (!response.ok) throw new Error(`the api refused a chat list: ${response.status}`);
      const page = ListConversationsResponseSchema.parse(await response.json());
      return {
        chats: page.conversations.map((c) => ({
          id: c.id,
          title: c.title,
          model: c.model,
          messageCount: c.messageCount,
          updatedAt: c.updatedAt,
          externalUserId: c.externalUserId,
          origin: originOf(c.externalUserId),
        })),
        nextCursor: page.nextCursor,
      };
    },

    async chat(access: ChatAccess, id: string): Promise<ChatView | undefined> {
      if (!isId(id)) return undefined;
      let page: ConversationPage;
      let messages: ConversationPage["messages"] = [];
      let after = 0;
      do {
        const response = await read(
          access,
          `/v1/conversations/${id}?after=${after}&limit=${MESSAGES_PER_PAGE}`,
        );
        if (!response) return undefined;
        page = GetConversationResponseSchema.parse(await response.json());
        messages = messages.concat(page.messages);
        after = page.nextAfter ?? after;
      } while (page.nextAfter !== null);
      const { conversation } = page;
      return {
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        system: conversation.system,
        externalUserId: conversation.externalUserId,
        origin: originOf(conversation.externalUserId),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages,
        busy: page.busy,
        lastError: page.lastError,
      };
    },

    async chatStatus(access: ChatAccess, id: string): Promise<ChatStatus | undefined> {
      if (!isId(id)) return undefined;
      const response = await read(
        access,
        `/v1/conversations/${id}?after=${PAST_THE_LAST_MESSAGE}&limit=1`,
      );
      if (!response) return undefined;
      const { busy, lastError } = GetConversationResponseSchema.parse(await response.json());
      return { busy, lastError };
    },

    async createChat(
      access: ChatAccess,
      form: FormInput,
    ): Promise<{ ok: true; id: string } | FormFailure> {
      const parsed = parseForm(CreateChatForm, trimmedMessage(form));
      if (!parsed.ok) return parsed;
      const { message, model, system } = parsed.data;
      // A provider with no key would fail at the first turn: say so in the form's words, not the API's.
      const provider = model ? parseModelId(model)?.provider : undefined;
      if (
        provider &&
        settings.modelProviders.includes(provider) &&
        !(await hasModelKey(control, access.session.tenantId, provider))
      ) {
        return {
          ok: false,
          fields: { model: `No ${provider} key yet: add one under Model providers.` },
        };
      }
      const created = await api({
        method: "POST",
        path: "/v1/conversations",
        token: access.token,
        body: CreateConversationRequestSchema.parse({
          externalUserId: `${CONSOLE_USER_PREFIX}${access.session.userId}`,
          ...(model ? { model } : {}),
          ...(system.trim() ? { system } : {}),
        }),
      });
      if (created.status !== 201) {
        const failure = await refusal(created);
        // The only 400 the api returns for these fields is a model it cannot use.
        return created.status === 400
          ? { ok: false, fields: { model: failure.error ?? "The model was refused." } }
          : failure;
      }
      const { id } = z.object({ id: z.uuid() }).parse(await created.json());
      const posted = await api({
        method: "POST",
        path: `/v1/conversations/${id}/messages`,
        token: access.token,
        body: { content: message },
      });
      if (posted.status !== 202) return refusal(posted);
      return { ok: true, id };
    },

    async sendMessage(
      access: ChatAccess,
      id: string,
      form: FormInput,
    ): Promise<{ ok: true; seq: number } | FormFailure> {
      if (!isId(id)) return refuse("This conversation no longer exists.");
      const parsed = parseForm(SendForm, trimmedMessage(form));
      if (!parsed.ok) return parsed;
      const posted = await api({
        method: "POST",
        path: `/v1/conversations/${id}/messages`,
        token: access.token,
        body: { content: parsed.data.message },
      });
      if (posted.status !== 202) return refusal(posted);
      return { ok: true, seq: z.object({ seq: z.number() }).parse(await posted.json()).seq };
    },

    chatEvents(
      access: ChatAccess,
      id: string,
      after: string | null,
      signal: AbortSignal,
    ): Promise<Response> {
      if (!isId(id) || (after !== null && !/^\d{1,10}$/.test(after))) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return api({
        method: "GET",
        path: `/v1/conversations/${id}/events${after === null ? "" : `?after=${after}`}`,
        token: access.token,
        headers: { accept: "text/event-stream" },
        stream: true,
        signal,
      });
    },
  };
}
