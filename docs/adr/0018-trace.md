# 0018. The trace: every complete event a run reports, kept beside the messages

- Status: proposed
- Date: 2026-11-23

## Context

ADR 0003 made `message_end` the only thing persisted: it is all a run needs to resume. Everything else a harness reports
(a tool starting and finishing, the run ending, the model's reasoning) went to clients as a live `NOTIFY` and was gone;
the reasoning of a Pi message survived only inside the assistant message's opaque `native`. A tenant that must answer
"what did the agent do, and why" for an audit had no record of it, and `AgentEvent`'s comment said the supervisor
persisted the rest, which it did not.

## Decision

- **The port carries reasoning.** `AgentEvent` gains `thinking_delta` (ephemeral, like `text_delta`) and `thinking_end`
  (one complete reasoning block; `redacted: true` with empty text when the provider withheld it). A harness emits what it
  has: one that exposes no reasoning never emits them. The Pi adapter ends a block when a later block begins or the message
  ends (`ThinkingForwarder`), so a block that finished before a crash is reported.
- **The trace is the complete events, not the deltas.** The supervisor records `run_start`, `message_start`,
  `thinking_end`, `tool_start`, `tool_end`, `run_end`, plus two of its own: `message_end` as a pointer (`seq`, `role`; the
  body is the message, not repeated) and `run_error` (why an attempt ended without a `run_end`; scrubbed of the tenant's
  model key, cut at 2000 characters). A text block's content is in its message, so there is no text event beyond the
  deltas. Each entry carries `runId` (one per attempt), `attempt`, `n` (position in the run) and `at`.
- **Storage is S3 segments and a Postgres index**, as for messages. Entries are buffered and written as one object per
  flush (`conversations/<id>/trace/<runId>-<firstN>-<sha16>.json`, blob kind `trace`), then one `trace_segments` row
  (tenant migration `conversations/0006_trace.sql`). The blobs count toward the tenant's `storageBytes`, not a
  conversation's byte cap. Unlike `messages` the index is **not fenced**: a run whose lease lapsed still happened, and
  its entries are the audit of it. `id` orders segments as recorded.
- **When it is written.** After a message is persisted, at `tool_start` (so a tool that hangs is visible), at `tool_end`,
  at `run_end`, and on the error path. A failed write throws, so the turn fails and Absurd retries it: the trace is never
  silently short. On the error path the write is best effort, because the error being thrown matters more.
- **Resume is unchanged.** A run is rebuilt from `messages` alone; no worker reads the trace.
- **Reading it.** `GET /v1/conversations/:id/trace?after=<cursor>&limit=<n>` (limit 1 to 1000, default 200; a page ends at
  a whole segment) with the tenant's API key or the console session's token. It holds reasoning text and tool arguments
  and results, which are the tenant's own.
- **The live stream hides reasoning unless asked.** `GET .../events?include=thinking` adds `thinking_delta` and
  `thinking_end` to the live events; without it the stream is as it was. They are live only (no SSE id, not replayed); the
  trace is the record. The public message form still omits `native`.

## Consequences

- Chosen over coalesced chunks (owner's call): only complete blocks are kept, so a text or reasoning block interrupted
  by a crash leaves nothing of its partial output. A reasoning block that completed before the crash is kept, and the
  retry's `run_start` shows where the attempt ended. Keeping partial blocks would mean storing the deltas.
- One extra S3 put and index insert per flush point, a handful per message. A crash between a persist and the flush that
  follows loses that message's pointer entry; the message itself is safe.
- A trace has no retention of its own: it lives as long as the conversation's other blobs.
- Not built: a console view of the trace, and a per-tenant or per-conversation default for `include`.
