// Chatting from the browser and browsing every conversation of the tenant, however it began. The data lives in the
// tenant's own database behind the api, which enforces its limits and quotas; the console reaches it with the person's
// session token, so the tenant is always the one the person belongs to (ADR 0014).
import {
  CreateConversationRequestSchema,
  GetConversationResponseSchema,
  ListConversationsResponseSchema,
  MAX_CONVERSATION_TOOLS,
  PromptNameSchema,
  PromptVersionParamSchema,
  ToolSelectionSchema,
} from "@kerby/contracts";
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
import {
  apiError,
  apiFault,
  CONSOLE_USER_PREFIX,
  missingModelKey,
  STUDIO_USER_PREFIX,
  toolsOf,
  variableValues,
} from "./api.ts";
import { parseForm, refuse } from "./forms.ts";

const CHATS_PER_PAGE = 40;
/** The api's page limit for messages: a conversation is read in as few requests as it allows. */
const MESSAGES_PER_PAGE = 500;
/** Past every message a conversation can hold: a read after it returns no messages, only whether a turn is running. */
const PAST_THE_LAST_MESSAGE = 2_147_483_647;

const originOf = (externalUserId: string | null): ChatOrigin =>
  externalUserId?.startsWith(CONSOLE_USER_PREFIX)
    ? "console"
    : externalUserId?.startsWith(STUDIO_USER_PREFIX)
      ? "studio"
      : "api";

const MessageField = z
  .string()
  .min(1, "write a message first")
  .max(1_000_000, "at most 1 000 000 characters");

const CreateChatForm = z.object({
  message: MessageField,
  model: z.string().trim().max(200, "at most 200 characters").default(""),
  system: z.string().max(100_000, "at most 100 000 characters").default(""),
  /** "Start from" a chat prompt: its name and a version number or label; blank for none. */
  promptName: z.string().trim().default(""),
  promptVersion: z.string().trim().default(""),
});

const SendForm = z.object({ message: MessageField });

/** A message typed in a form: trimmed, so a blank one is refused as empty. */
const trimmedMessage = (form: FormInput): FormInput => ({
  ...form,
  message: typeof form.message === "string" ? form.message.trim() : form.message,
});

/** What the person is told when the api refuses a post. A fault on our side (5xx, a bad credential) is thrown instead. */
async function refusal(response: Response): Promise<FormFailure> {
  const { code, message } = await apiError(response);
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
      return refuse(message ?? "The request was refused.");
    case "unknown_tool":
    case "too_many_tools":
    case "tool_not_granted":
      return { ok: false, fields: { tools: message ?? "A tool was refused." } };
  }
  throw apiFault("chat", response.status, code);
}

/** Why the api refused to start a conversation from a chat prompt. */
async function promptRefusal(response: Response): Promise<FormFailure> {
  const { code, message } = await apiError(response);
  switch (code) {
    case "not_found":
      return {
        ok: false,
        fields: { promptVersion: "This prompt or version no longer exists. Choose another." },
      };
    case "wrong_kind":
      return {
        ok: false,
        fields: { promptName: "This is a decision model: choose a chat prompt." },
      };
    case "invalid_variables":
    case "invalid_model":
    case "storage_quota_exceeded":
    case "unknown_tool":
    case "too_many_tools":
    case "tool_not_granted":
      // A prompt's own tools: the person cannot change them here, only in the Studio.
      return refuse(message ?? "The request was refused.");
    case "rate_limited":
      return refuse("Too many requests. Try again in a moment.");
  }
  throw apiFault("chat", response.status, code);
}

type ConversationPage = z.output<typeof GetConversationResponseSchema>;

export function createChats(deps: ConsoleDeps) {
  const { api } = deps;

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
        prompt: conversation.prompt,
        tools: conversation.tools,
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
      const { message, model, system, promptName, promptVersion } = parsed.data;
      let request: z.input<typeof CreateConversationRequestSchema>;
      if (promptName) {
        // The prompt sets the system prompt, model, guardrails and tools: the free fields are ignored.
        const name = PromptNameSchema.safeParse(promptName);
        if (!name.success) return { ok: false, fields: { promptName: "Choose a chat prompt." } };
        const version = PromptVersionParamSchema.safeParse(promptVersion);
        if (!version.success) return { ok: false, fields: { promptVersion: "Choose a version." } };
        const variables = variableValues(form);
        request = {
          externalUserId: `${CONSOLE_USER_PREFIX}${access.session.userId}`,
          prompt: {
            name: name.data,
            version: version.data,
            ...(Object.keys(variables).length > 0 ? { variables } : {}),
          },
        };
      } else {
        // A provider with no key would fail at the first turn: say so in the form's words, not the API's.
        const noKey = await missingModelKey(deps, access.session.tenantId, model);
        if (noKey) return { ok: false, fields: { model: noKey } };
        const tools = ToolSelectionSchema.safeParse(toolsOf(form));
        if (!tools.success) {
          return {
            ok: false,
            fields: { tools: `Choose at most ${MAX_CONVERSATION_TOOLS} tools.` },
          };
        }
        request = {
          externalUserId: `${CONSOLE_USER_PREFIX}${access.session.userId}`,
          ...(model ? { model } : {}),
          ...(system.trim() ? { system } : {}),
          ...(tools.data.length > 0 ? { tools: tools.data } : {}),
        };
      }
      const created = await api({
        method: "POST",
        path: "/v1/conversations",
        token: access.token,
        body: CreateConversationRequestSchema.parse(request),
      });
      if (created.status !== 201) {
        if (promptName) return promptRefusal(created);
        const failure = await refusal(created);
        // A 400 is a model it cannot use, unless it named a tool.
        return created.status === 400 && !failure.fields
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
