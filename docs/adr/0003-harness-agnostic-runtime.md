# 0003. The agent harness is replaceable: AgentRuntime and AgentEvent

- Status: proposed
- Date: 2026-11-21

## Context

Harnesses change faster than a platform should. Lochmoore couples to Pi Durable: its SQLite file is the only copy of
a conversation, so a chat is pinned to a worker and the harness's state is the system of record.

## Decision

- `packages/agent` defines the port ([source](../../packages/agent/src/index.ts)): `AgentRuntime.run(AgentRun)` returns
  an `AsyncIterable<AgentEvent>`. Messages are Kerby's own JSON types.
- A harness is an adapter, `packages/runtime-<harness>`, the only importer of that harness. Only a service's
  `src/index.ts` imports an adapter. Mapping native events to `AgentEvent` is the one harness-specific transformation.
- **The harness holds no durable state.** First adapter: Pi Durable on `MemoryStorage`. Every event goes to the parent
  (the run supervisor in an Absurd task), which persists each `message_end` to S3 and the Postgres index and records the
  complete events in the conversation's trace ([ADR 0018](0018-trace.md)). A restart rehydrates a fresh harness from the
  persisted messages and continues. Absurd gives the retry; the message index gives the resume.
- **Tools run through Kerby.** The harness decides when to call; `AgentRun.executeTool` runs it as an Absurd step keyed by
  tool-call id, scoped to the tenant. A runtime never executes a tool itself.
- A pull-based `AsyncIterable` gives backpressure: the supervisor persists an event before the runtime continues.
- The port carries no tenant, user, or conversation id.

## Consequences

- Workers are stateless and interchangeable. No worker assignment, per-worker queues, or volumes to back up.
- Verified for Pi Durable on `MemoryStorage` (plan 0001, S1): a fresh harness is seeded with user, assistant (with tool
  calls) and tool-result entries through `commit` and `appendEntry`, and the model sees that history. Pi Durable has no
  "continue without input", so the adapter submits a sentinel user input and removes it in a `beforeRequest` hook (the
  model sees history ending at the tool result) and from the event stream. Pi Durable's own `system` entries are not Kerby
  messages and are dropped. A seeded tool call without a result gets a placeholder result from the harness, so the adapter
  resolves such calls itself first. Pi's messages carry more than the neutral type (thinking blocks, provider, timestamps):
  they ride in `native`.
- A second adapter plus a conformance suite is what proves the port; until then it is v0 and may change by editing
  `packages/agent` and its one adapter.
- Model calls interrupted mid-message are regenerated, not resumed: the partial message was never persisted.
