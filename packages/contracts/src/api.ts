// The tenant-facing HTTP API (services/api). Request and response bodies, and the SSE event envelope.
import { z } from "zod";
import { AgentEventSchema, AgentMessageSchema, ContentPartSchema } from "./agent.ts";
import { GuardrailsSchema } from "./judgment.ts";
import { ChatPromptRefSchema, MAX_PROMPT_TEXT, PinnedPromptSchema } from "./prompt-ref.ts";
import { ToolPatternSchema, ToolSelectionSchema } from "./tools.ts";

const Id = z.string().min(1).max(128);

export const CreateConversationRequestSchema = z
  .object({
    /** The tenant's own name for the end user. Kerby does not authenticate end users. */
    externalUserId: Id.optional(),
    /** A Kerby model id, `<provider>/<modelId>`; the tenant must hold a key for the provider. Defaults to the deployment default. */
    model: z.string().min(1).max(200).optional(),
    system: z.string().max(MAX_PROMPT_TEXT).optional(),
    /** Guardrails for this conversation; the tenant must hold a key for the default judgment provider. */
    guardrails: GuardrailsSchema.optional(),
    /**
     * The tools the assistant may call (ADR 0022), as `<server>/<tool>` or `<server>/*`. None named, none offered. The
     * caller's integration must be granted every one.
     */
    tools: ToolSelectionSchema.optional(),
    /**
     * A published chat prompt (ADR 0017): it sets the system prompt (its text, variables filled in), the model, the
     * guardrails and the tools, so none of those four may be given with it.
     */
    prompt: ChatPromptRefSchema.optional(),
  })
  .refine(
    (request) =>
      request.prompt === undefined ||
      (request.system === undefined &&
        request.model === undefined &&
        request.guardrails === undefined &&
        request.tools === undefined),
    {
      message: "a prompt sets system, model, guardrails and tools: leave them out",
      path: ["prompt"],
    },
  );
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const ConversationSchema = z.object({
  id: z.uuid(),
  externalUserId: z.string().nullable(),
  /** The integration that started it (ADR 0020); null when a person started it in the console. */
  integrationId: z.uuid().nullable(),
  model: z.string(),
  system: z.string(),
  /** The opening of the first user message; null before one is posted, and for conversations older than titles. */
  title: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** When a message was last added (creation time until then): the order of `GET /v1/conversations`. */
  updatedAt: z.iso.datetime(),
  /** Conditions checked before the assistant acts on a user message or runs a tool (ADR 0016). Empty for none. */
  guardrails: GuardrailsSchema.default([]),
  /** The chat prompt version it was started from (ADR 0017); null when the request wrote its own system prompt. */
  prompt: PinnedPromptSchema.nullable().default(null),
  /** The tools it may call (ADR 0022), by the servers' current names; a deleted server's drop out. */
  tools: z.array(ToolPatternSchema).default([]),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** A conversation in a list: everything but the system prompt, guardrails and tools, with how many messages it holds. */
const ConversationSummarySchema = ConversationSchema.omit({
  system: true,
  guardrails: true,
  tools: true,
}).extend({
  messageCount: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * `GET /v1/conversations?limit=<n>&cursor=<c>&externalUserId=<id>`: the tenant's conversations, most recently active
 * first, whoever started them. `cursor` is a previous page's `nextCursor`; `limit` is 1 to 100, default 30.
 */
export const ListConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(100).optional(),
  externalUserId: Id.optional(),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuerySchema>;

export const ListConversationsResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ListConversationsResponse = z.infer<typeof ListConversationsResponseSchema>;

/** A persisted message as clients see it: the harness's `native` payload stays inside Kerby. */
export const PublicMessageSchema = z.discriminatedUnion("role", [
  AgentMessageSchema.options[0],
  AgentMessageSchema.options[1].omit({ native: true }),
  AgentMessageSchema.options[2].omit({ native: true }),
]);
export type PublicMessage = z.infer<typeof PublicMessageSchema>;

const MessageSchema = z.object({
  /** Position in the conversation, from 1, assigned once. Also the SSE event id basis. */
  seq: z.number().int().positive(),
  message: PublicMessageSchema,
  createdAt: z.iso.datetime(),
});

/**
 * `GET /v1/conversations/:id?after=<seq>&limit=<n>`: one page of messages, oldest first, those with `seq` greater
 * than `after` (default 0). `limit` is 1 to 500, default 100.
 */
export const GetConversationQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type GetConversationQuery = z.infer<typeof GetConversationQuerySchema>;

export const GetConversationResponseSchema = z.object({
  conversation: ConversationSchema,
  /** One page, oldest first: see `GetConversationQuerySchema`. */
  messages: z.array(MessageSchema),
  /** Pass as `after` for the next page; null when this page reaches the newest message. */
  nextAfter: z.number().int().positive().nullable(),
  /** True while a turn is queued or running. */
  busy: z.boolean(),
  /** Why the latest turn produced no answer (the provider refused it, or it failed for good); cleared by the next message. */
  lastError: z.string().nullable(),
});
export type GetConversationResponse = z.infer<typeof GetConversationResponseSchema>;

export const PostMessageRequestSchema = z.object({
  /** Plain text, or content parts. */
  content: z.union([z.string().min(1).max(1_000_000), z.array(ContentPartSchema).min(1)]),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const PostMessageResponseSchema = z.object({
  /** The user message's position; the turn that answers it starts after it. */
  seq: z.number().int().positive(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

/** One server-sent event's `data`. `seq` orders events within a conversation and is the SSE `id`. */
export const EventEnvelopeSchema = z.object({
  v: z.literal(1),
  conversationId: z.uuid(),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  event: AgentEventSchema,
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
