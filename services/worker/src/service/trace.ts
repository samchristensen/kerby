// The run's trace (ADR 0018): what the runtime reports, complete and in order, kept beside the messages. Events are
// buffered and stored a segment at a time, at the points where something happened that a crash must not erase: a
// message persisted, a tool started or finished, the run ended. Nothing here is needed to resume a turn.
import type { AgentEvent } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import type { TraceEntry, TraceEvent } from "@kerby/contracts";
import { appendTrace } from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";

/** The part of an agent event the trace keeps: everything complete, nothing streamed in pieces. `message_end` is the supervisor's. */
export function traceOf(event: AgentEvent): TraceEvent | undefined {
  switch (event.type) {
    case "run_start":
    case "message_start":
    case "thinking_end":
    case "tool_start":
    case "tool_end":
    case "run_end":
      return event;
    case "text_delta":
    case "thinking_delta":
    case "message_end":
      return undefined;
  }
}

export class TraceRecorder {
  readonly #ctx: TenantContext;
  readonly #blobs: Blobs;
  readonly #conversationId: string;
  readonly #run: { runId: string; attempt: number };
  #pending: TraceEntry[] = [];
  #n = 0;

  constructor(
    ctx: TenantContext,
    blobs: Blobs,
    conversationId: string,
    run: { runId: string; attempt: number },
  ) {
    this.#ctx = ctx;
    this.#blobs = blobs;
    this.#conversationId = conversationId;
    this.#run = run;
  }

  record(event: TraceEvent): void {
    this.#pending.push({
      runId: this.#run.runId,
      attempt: this.#run.attempt,
      n: ++this.#n,
      at: new Date().toISOString(),
      event,
    });
  }

  /** Store what is buffered. A failure throws and keeps the entries, so the turn fails and a later flush may still write them. */
  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    await appendTrace(this.#ctx, this.#blobs, this.#conversationId, this.#pending);
    this.#pending = [];
  }
}
