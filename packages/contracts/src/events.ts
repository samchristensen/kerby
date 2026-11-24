// The event log (ADR 0019): what happened in a tenant, as thin, typed facts. Pulled with `GET /v1/events`, pushed to
// subscriptions. An event carries ids, sequence numbers and status, never message content: read that with the API.
import { z } from "zod";

/** Every type the log records. `ping` is not one: it is sent only to test a subscription. */
export const EVENT_TYPES = [
  "conversation.created",
  "message.created",
  "turn.started",
  "turn.completed",
  "turn.blocked",
  "turn.failed",
  "judgment.completed",
  "judgment.failed",
] as const;
const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

/**
 * Why a turn produced no answer. `no_model_key`, `guardrail_unavailable` and `too_many_tools` (the conversation's tools
 * past the per-turn cap, ADR 0022) repeat until the tenant fixes them.
 */
export const TURN_FAILURE_REASONS = [
  "no_model_key",
  "guardrail_unavailable",
  "too_many_tools",
  "refused",
  "error",
] as const;

const conversationId = z.uuid();
const seq = z.number().int().positive();

/** Each type's `data`. */
const EventDataSchemas = {
  "conversation.created": z.object({ conversationId, externalUserId: z.string().nullable() }),
  "message.created": z.object({
    conversationId,
    seq,
    role: z.enum(["user", "assistant", "tool"]),
  }),
  /** `seq` is the user message the turn answers: it names the turn. */
  "turn.started": z.object({ conversationId, seq }),
  /** `lastSeq` is the turn's last message. */
  "turn.completed": z.object({ conversationId, seq, lastSeq: seq }),
  /** The user message was blocked by `guardrails`; `lastSeq` is the refusal Kerby wrote in the assistant's place. */
  "turn.blocked": z.object({
    conversationId,
    seq,
    lastSeq: seq,
    guardrails: z.array(z.string()),
  }),
  "turn.failed": z.object({
    conversationId,
    seq,
    reason: z.enum(TURN_FAILURE_REASONS),
    error: z.string(),
  }),
  "judgment.completed": z.object({
    judgmentId: z.uuid(),
    status: z.enum(["answered", "refused"]),
  }),
  "judgment.failed": z.object({ judgmentId: z.uuid(), error: z.string() }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventData<T extends EventType> = z.infer<(typeof EventDataSchemas)[T]>;

const base = {
  id: z.uuid(),
  v: z.literal(1),
  createdAt: z.iso.datetime(),
  /** The integration whose work it is (ADR 0020); null for work started by a person in the console. */
  integrationId: z.uuid().nullable(),
};

export const PublicEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("conversation.created"),
    data: EventDataSchemas["conversation.created"],
  }),
  z.object({
    ...base,
    type: z.literal("message.created"),
    data: EventDataSchemas["message.created"],
  }),
  z.object({ ...base, type: z.literal("turn.started"), data: EventDataSchemas["turn.started"] }),
  z.object({
    ...base,
    type: z.literal("turn.completed"),
    data: EventDataSchemas["turn.completed"],
  }),
  z.object({ ...base, type: z.literal("turn.blocked"), data: EventDataSchemas["turn.blocked"] }),
  z.object({ ...base, type: z.literal("turn.failed"), data: EventDataSchemas["turn.failed"] }),
  z.object({
    ...base,
    type: z.literal("judgment.completed"),
    data: EventDataSchemas["judgment.completed"],
  }),
  z.object({
    ...base,
    type: z.literal("judgment.failed"),
    data: EventDataSchemas["judgment.failed"],
  }),
]);
export type PublicEvent = z.infer<typeof PublicEventSchema>;

/** What a subscription test sends: no data, never in the log. */
export const PingEventSchema = z.object({ ...base, type: z.literal("ping"), data: z.object({}) });

const WILDCARDS = [
  "*",
  ...new Set(EVENT_TYPES.map((type) => `${type.slice(0, type.indexOf("."))}.*`)),
] as const;

/** A type, `<family>.*` (e.g. `turn.*`), or `*`. */
export const EventTypePatternSchema = z.union([EventTypeSchema, z.enum(WILDCARDS)], {
  error: `an event type (${EVENT_TYPES.join(", ")}), a family wildcard such as turn.*, or *`,
});
export type EventTypePattern = z.infer<typeof EventTypePatternSchema>;

/** The concrete types a set of patterns selects, in catalog order. */
export function expandEventTypes(patterns: readonly EventTypePattern[]): EventType[] {
  return EVENT_TYPES.filter((type) =>
    patterns.some(
      (pattern) =>
        pattern === "*" ||
        pattern === type ||
        (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1))),
    ),
  );
}

/** A position in the log: `<transaction>.<position>`, opaque to clients. */
const EventCursorSchema = z
  .string()
  .regex(/^\d{1,20}\.\d{1,19}$/, "a cursor is a previous response's next");

/**
 * `GET /v1/events?after=<cursor>&limit=<n>&types=<patterns>&conversationId=<id>&wait=<s>`: events after `after` (from
 * the oldest kept, 30 days, without it), oldest first. `types` is comma-separated patterns. `wait` holds the request
 * open up to that many seconds until an event arrives (long-poll).
 */
export const ListEventsQuerySchema = z.object({
  after: EventCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  types: z
    .string()
    .transform((value) => value.split(",").map((part) => part.trim()))
    .pipe(z.array(EventTypePatternSchema).min(1).max(20))
    .optional(),
  conversationId: z.uuid().optional(),
  wait: z.coerce.number().int().min(0).max(30).default(0),
});

export const ListEventsResponseSchema = z.object({
  events: z.array(PublicEventSchema),
  /** Pass as `after` next time. It moves even when nothing matched, so a quiet filter never rescans. */
  next: EventCursorSchema,
});
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;
