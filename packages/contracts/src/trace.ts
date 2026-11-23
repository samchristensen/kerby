// A conversation's trace: everything its runs reported, complete and in order, beside the messages (ADR 0018).
// What the supervisor records and what `GET /v1/conversations/:id/trace` returns.
import { z } from "zod";
import { ToolCallSchema, ToolResultSchema } from "./agent.ts";

/**
 * One thing a run did. The agent events that are complete (not the deltas), and two the supervisor adds: a
 * `message_end` here points at the message by its position (the body is the message, not repeated), and `run_error`
 * says why an attempt ended without a `run_end`.
 */
const TraceEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run_start") }),
  z.object({ type: z.literal("message_start"), role: z.literal("assistant") }),
  z.object({
    type: z.literal("thinking_end"),
    text: z.string(),
    redacted: z.literal(true).exactOptional(),
  }),
  z.object({ type: z.literal("tool_start"), call: ToolCallSchema }),
  z.object({ type: z.literal("tool_end"), call: ToolCallSchema, result: ToolResultSchema }),
  z.object({
    type: z.literal("message_end"),
    /** The persisted message's position: `GET /v1/conversations/:id?after=<seq - 1>&limit=1`. */
    seq: z.number().int().positive(),
    role: z.enum(["assistant", "tool"]),
  }),
  z.object({
    type: z.literal("run_end"),
    reason: z.enum(["done", "aborted", "refused", "failed"]),
    error: z.string().exactOptional(),
  }),
  z.object({ type: z.literal("run_error"), error: z.string() }),
]);
export type TraceEvent = z.infer<typeof TraceEventSchema>;

export const TraceEntrySchema = z.object({
  /** The Absurd run that reported it: one per attempt, so a retried turn shows each attempt apart. */
  runId: z.string(),
  attempt: z.number().int().positive(),
  /** Position within the run, from 1. */
  n: z.number().int().positive(),
  at: z.iso.datetime(),
  event: TraceEventSchema,
});
export type TraceEntry = z.infer<typeof TraceEntrySchema>;

/**
 * `GET /v1/conversations/:id/trace?after=<cursor>&limit=<n>`: the trace in the order it was recorded. `limit` is 1 to
 * 1000, default 200, and a page ends at a whole stored segment, so it may hold a few more.
 */
export const GetTraceQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type GetTraceQuery = z.infer<typeof GetTraceQuerySchema>;

export const GetTraceResponseSchema = z.object({
  events: z.array(TraceEntrySchema),
  /** Pass as `after` for the next page; null when this page reaches the newest entry. */
  nextAfter: z.number().int().positive().nullable(),
});
export type GetTraceResponse = z.infer<typeof GetTraceResponseSchema>;

/** What `GET .../events?include=` may ask the live stream to add. Absent means the stream as it always was. */
export const STREAM_INCLUDES = ["thinking"] as const;
export const StreamIncludeSchema = z
  .string()
  .default("")
  .transform((value) => (value === "" ? [] : value.split(",")))
  .pipe(z.array(z.enum(STREAM_INCLUDES)));
export type StreamInclude = (typeof STREAM_INCLUDES)[number];
