// The port between Kerby and any agent harness (ADR 0003). Types only: nothing here names a model
// provider or an agent library, and nothing may. An adapter (`packages/runtime-<harness>`) maps one
// harness onto this contract; everything else in Kerby sees only these types.

/** A piece of message content. Bytes never travel inline: a blob is a reference into object storage. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "blob"; blobId: string; mediaType: string };

/** A model's request to run a tool. `id` is stable once the assistant message holding it is persisted. */
export type ToolCall = { type: "tool_call"; id: string; name: string; input: unknown };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
};

/**
 * Harness-neutral and JSON-serializable: this is what Kerby persists and what a run is rehydrated from.
 * `native` is opaque data only the adapter that wrote it reads back (provider thinking blocks and signatures,
 * timestamps, anything a harness needs to continue faithfully). Kerby stores it verbatim and never looks inside.
 */
export type AgentMessage =
  | { role: "user"; content: ContentPart[] }
  | {
      role: "assistant";
      content: (ContentPart | ToolCall)[];
      model: string;
      stopReason: "end" | "tool_use" | "length";
      usage?: Usage;
      native?: unknown;
    }
  | {
      role: "tool";
      toolCallId: string;
      content: ContentPart[];
      isError: boolean;
      native?: unknown;
    };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema (type: object) of `ToolCall.input`. */
  inputSchema: Record<string, unknown>;
  /** A read-only tool may run again after a crash; any other tool runs once (see AgentRun.executeTool). */
  readOnly: boolean;
};

export type ToolResult = { content: ContentPart[]; isError: boolean };

/**
 * What a run is told to do, and with what. There is no tenant, user, or conversation id here, by design:
 * a runtime that never sees them cannot cross them. Kerby's closures carry them.
 */
export type AgentRun = {
  system: string;
  /** A Kerby model id, `<provider>/<modelId>`; the adapter maps it to its provider. */
  model: string;
  /**
   * The caller's own API key for the model's provider (bring your own key), opened for this run only. Absent for a
   * model that needs none. An adapter hands it to the provider client and nowhere else: not to a log, an event, a
   * message, or an error.
   */
  apiKey?: string;
  /**
   * Everything before this run, in order. Empty for a new conversation. A new process given only this
   * continues the conversation: a runtime keeps no state Kerby cannot rebuild from `history`.
   * It ends with a `user` or `tool` message (continue from there) or an `assistant` message with no
   * tool calls (nothing to do: end the run at once).
   */
  history: AgentMessage[];
  tools: ToolSpec[];
  /**
   * The only way a tool runs. The harness decides when to call; Kerby runs it (checkpointed, scoped to the
   * tenant, audited). A runtime never executes a tool itself.
   */
  executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** Bytes of a `blob` content part. */
  readBlob(blobId: string): Promise<Uint8Array>;
  signal: AbortSignal;
};

/**
 * Everything a run reports, in order. The supervisor persists these; only `message_end` is needed to
 * rehydrate, the rest is the full-fidelity transcript and the live view.
 */
export type AgentEvent =
  | { type: "run_start" }
  | { type: "message_start"; role: "assistant" }
  /** Ephemeral: streamed to clients, kept in the transcript, never needed to resume. */
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  /**
   * The durable unit: a complete message (assistant and tool messages alike), emitted once, in order.
   * A runtime does not run a tool until the `message_end` that carries its call has been consumed.
   */
  | { type: "message_end"; message: AgentMessage }
  /** Always last. `refused`: the provider rejected the request itself, so a retry gets the same answer. */
  | { type: "run_end"; reason: "done" | "aborted" | "refused"; error?: string };

/**
 * A harness behind the port. Infrastructure failures throw out of the iterator so the task retries;
 * a run that ended on purpose ends with `run_end`.
 */
export interface AgentRuntime {
  readonly name: string;
  run(run: AgentRun): AsyncIterable<AgentEvent>;
}
