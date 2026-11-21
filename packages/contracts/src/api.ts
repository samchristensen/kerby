// The tenant-facing HTTP API (services/api). Request and response bodies, and the SSE event envelope.
import { z } from "zod";
import { AgentEventSchema, AgentMessageSchema, ContentPartSchema } from "./agent.ts";

const Id = z.string().min(1).max(128);

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const CreateConversationRequestSchema = z.object({
  /** The tenant's own name for the end user. Kerby does not authenticate end users. */
  externalUserId: Id.optional(),
  /** A Kerby model id. Defaults to the tenant's default. */
  model: z.string().min(1).max(200).optional(),
  system: z.string().max(100_000).optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const ConversationSchema = z.object({
  id: z.uuid(),
  externalUserId: z.string().nullable(),
  model: z.string(),
  system: z.string(),
  createdAt: z.iso.datetime(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** A persisted message as clients see it: the harness's `native` payload stays inside Kerby. */
export const PublicMessageSchema = z.discriminatedUnion("role", [
  AgentMessageSchema.options[0],
  AgentMessageSchema.options[1].omit({ native: true }),
  AgentMessageSchema.options[2].omit({ native: true }),
]);
export type PublicMessage = z.infer<typeof PublicMessageSchema>;

export const MessageSchema = z.object({
  /** Position in the conversation, from 1, assigned once. Also the SSE event id basis. */
  seq: z.number().int().positive(),
  message: PublicMessageSchema,
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const GetConversationResponseSchema = z.object({
  conversation: ConversationSchema,
  messages: z.array(MessageSchema),
  /** True while a turn is queued or running. */
  busy: z.boolean(),
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
