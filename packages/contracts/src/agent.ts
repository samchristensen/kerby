// zod mirrors of the AgentRuntime port types (packages/agent), so what is persisted and streamed is validated
// where it is read. `agent.test.ts` fails to compile if a schema drifts from its type.
import { z } from "zod";

export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("blob"), blobId: z.string(), mediaType: z.string() }),
]);

export const ToolCallSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().exactOptional(),
  cacheWriteTokens: z.number().exactOptional(),
  costUsd: z.number().exactOptional(),
});

export const AgentMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.array(ContentPartSchema) }),
  z.object({
    role: z.literal("assistant"),
    content: z.array(z.union([ContentPartSchema, ToolCallSchema])),
    model: z.string(),
    stopReason: z.enum(["end", "tool_use", "length"]),
    usage: UsageSchema.exactOptional(),
    native: z.unknown().exactOptional(),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string(),
    content: z.array(ContentPartSchema),
    isError: z.boolean(),
    native: z.unknown().exactOptional(),
  }),
]);

export const ToolResultSchema = z.object({
  content: z.array(ContentPartSchema),
  isError: z.boolean(),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_start") }),
  z.object({ type: z.literal("message_start"), role: z.literal("assistant") }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("thinking_delta"), text: z.string() }),
  z.object({
    type: z.literal("thinking_end"),
    text: z.string(),
    redacted: z.literal(true).exactOptional(),
  }),
  z.object({ type: z.literal("tool_start"), call: ToolCallSchema }),
  z.object({ type: z.literal("tool_end"), call: ToolCallSchema, result: ToolResultSchema }),
  z.object({ type: z.literal("message_end"), message: AgentMessageSchema }),
  z.object({
    type: z.literal("run_end"),
    reason: z.enum(["done", "aborted", "refused"]),
    error: z.string().exactOptional(),
  }),
]);
