// The `run-turn` task body and its supervisor (ARCHITECTURE.md#durability-the-turn-lifecycle): rehydrate from the
// tenant's index, run through the AgentRuntime port, and persist every `message_end` before pulling the next event,
// which is what makes the runtime's "no tool before its message is stored" gate hold.
import type { AgentEvent, AgentMessage, AgentRun, ToolResult } from "@kerby/agent";
import { parseModelId } from "@kerby/contracts";
import { recordUsage } from "@kerby/control-plane";
import {
  findConversation,
  LeaseLostError,
  notifyLive,
  persistMessage,
  readHistory,
  recordToolExecution,
  SeqConflictError,
  setLastError,
} from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext, type TaskParams } from "@kerby/durable";
import { alert, errorFields, log } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";
import { checkUserMessage, guardToolCall } from "./guardrails.ts";
import { judgeTool } from "./judgments.ts";
import { tenantTools } from "./tools.ts";
import { TraceRecorder, traceOf } from "./trace.ts";

/** Live events are batched: text deltas arrive many times a second and each notification is a round trip. */
const DELTA_FLUSH_CHARS = 400;
const DELTA_FLUSH_MS = 100;

class LiveEvents {
  readonly #ctx: TenantContext;
  readonly #conversationId: string;
  readonly #runId: string;
  readonly #position: () => number;
  #pending: { type: "text_delta" | "thinking_delta"; text: string } | undefined;
  #lastFlush = 0;

  constructor(ctx: TenantContext, conversationId: string, runId: string, position: () => number) {
    this.#ctx = ctx;
    this.#conversationId = conversationId;
    this.#runId = runId;
    this.#position = position;
  }

  async send(event: AgentEvent): Promise<void> {
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      // Text and reasoning never share a notification: a change of kind sends what is held first.
      if (this.#pending && this.#pending.type !== event.type) await this.flush();
      this.#pending = { type: event.type, text: (this.#pending?.text ?? "") + event.text };
      if (
        this.#pending.text.length >= DELTA_FLUSH_CHARS ||
        Date.now() - this.#lastFlush >= DELTA_FLUSH_MS
      ) {
        await this.flush();
      }
      return;
    }
    await this.flush();
    await this.#emit(event);
  }

  /** Send any held text or reasoning now (before a persist, so clients see it before the message that holds it). */
  async flush(): Promise<void> {
    const held = this.#pending;
    if (!held || held.text.length === 0) return;
    this.#pending = undefined;
    this.#lastFlush = Date.now();
    await this.#emit({ type: held.type, text: held.text });
  }

  async #emit(event: AgentEvent): Promise<void> {
    try {
      await notifyLive(this.#ctx.db, this.#conversationId, {
        v: 1,
        conversationId: this.#conversationId,
        runId: this.#runId,
        seq: this.#position(),
        at: new Date().toISOString(),
        event,
      });
    } catch (error) {
      // Live events are a courtesy: the persisted messages are the record.
      log("warn", "could not send a live event", errorFields(error));
    }
  }
}

export async function runTurn(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["run-turn"],
  run: RunContext,
): Promise<void> {
  const { conversationId } = params;
  const started = performance.now();
  let persisted = 0;
  const conversation = await findConversation(ctx.db, conversationId);
  if (!conversation) throw new Error(`conversation ${conversationId} does not exist`);

  // Rehydrate: the newest whole turns that fit the history budget, and the position of the next message.
  const history = await readHistory(
    ctx,
    deps.blobs,
    conversationId,
    deps.settings.historyBudgetBytes,
  );
  if (history.dropped.messages > 0) {
    log("info", "history cut to its budget: older turns left out", {
      conversationId,
      keptMessages: history.messages.length,
      keptBytes: history.bytes,
      droppedMessages: history.dropped.messages,
      droppedBytes: history.dropped.bytes,
      budgetBytes: deps.settings.historyBudgetBytes,
    });
  }
  let nextSeq = history.lastSeq + 1;

  /** Bill an answer once: the dedupe key is its position. */
  const meter = async (seq: number, message: AgentMessage): Promise<void> => {
    if (message.role !== "assistant" || !message.usage) return;
    const usage = message.usage;
    await recordUsage(deps.control, {
      tenantId: ctx.tenantId,
      dedupeKey: `${conversationId}:${seq}`,
      model: message.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
    });
  };
  // An earlier attempt may have persisted an answer of this turn and died before billing it; the harness never reports
  // a persisted message again, so bill what this turn already holds before anything else. Repeats are no-ops.
  for (const stored of history.messages) {
    if (stored.seq > params.seq) await meter(stored.seq, stored.message);
  }
  const tools = tenantTools({
    enableEcho: deps.settings.enableEchoTool,
    judge: await judgeTool(deps, ctx.tenantId, conversationId),
  });

  // Bring your own key: the tenant's key for the model's provider, opened for this run only.
  let apiKey: string | undefined;
  if (deps.modelKeys) {
    const provider = parseModelId(conversation.model)?.provider;
    apiKey = provider ? await deps.modelKeys(ctx.tenantId, provider) : undefined;
    if (!apiKey) {
      // The same turn gets the same answer until the tenant adds a key: no retry.
      await setLastError(
        ctx.db,
        conversationId,
        provider
          ? `no model key for provider "${provider}": PUT /v1/model-keys/${provider}, then post a message`
          : `model "${conversation.model}" must look like <provider>/<modelId>`,
      );
      log("warn", "turn refused: no model key", { provider: provider ?? "invalid" });
      return;
    }
  }
  /** A provider's error can quote the key it rejected; nothing that leaves this function may. */
  const scrub = (text: string): string => (apiKey ? text.replaceAll(apiKey, "[redacted]") : text);

  const agentRun: AgentRun = {
    system: conversation.system,
    model: conversation.model,
    ...(apiKey === undefined ? {} : { apiKey }),
    history: history.messages.map((s) => s.message),
    tools: tools.specs(),
    // The only way a tool runs: an Absurd step keyed by the call id, so a retried turn gets the stored result and
    // does not repeat a side effect. `recordToolExecution` counts real runs inside the step.
    executeTool: (call, signal): Promise<ToolResult> =>
      run.step(`tool:${call.id}`, async () => {
        // A guardrail that stops the call answers in the tool's place: the model reads why, and the tool never runs.
        const stopped = await guardToolCall(deps, ctx.tenantId, conversation, call, signal);
        if (stopped) return stopped;
        await recordToolExecution(ctx.db, { conversationId, callId: call.id, name: call.name });
        return tools.execute(call, signal);
      }),
    readBlob: async (blobId) => (await deps.blobs.get(ctx, blobId)).body,
    signal: run.signal,
  };

  const live = new LiveEvents(ctx, conversationId, run.runId, () => nextSeq);
  const trace = new TraceRecorder(ctx, deps.blobs, conversationId, run);
  try {
    // Guardrails on the user message come first: nothing is sent to the model, or paid for, until it has passed.
    const verdict = await checkUserMessage(deps, ctx, conversation, params.seq, run);
    if (verdict.type === "unavailable") {
      // The same message gets the same answer until the tenant fixes the key or the policy: no retry.
      await setLastError(
        ctx.db,
        conversationId,
        `a guardrail could not be checked, so the message was not answered: ${scrub(verdict.error)}`,
      );
      log("warn", "turn refused: a guardrail could not be checked");
      return;
    }
    if (verdict.type === "blocked") {
      // The user sees an answer, not silence; both messages are flagged, so no later turn sends either to a model.
      const seq = params.seq + 1;
      nextSeq = seq;
      const refusal: AgentMessage = {
        role: "assistant",
        model: conversation.model,
        stopReason: "end",
        content: [
          {
            type: "text",
            text: `This message was blocked by ${verdict.by.length === 1 ? "guardrail" : "guardrails"} ${verdict.by.map((name) => `"${name}"`).join(", ")}.`,
          },
        ],
      };
      await live.send({ type: "run_start" });
      trace.record({ type: "run_start" });
      await run.step(`persist:${seq}`, () =>
        persistMessage(ctx, deps.blobs, {
          conversationId,
          seq,
          message: refusal,
          blockedBy: verdict.by,
          run,
        }),
      );
      await live.send({ type: "run_end", reason: "done" });
      trace.record({ type: "message_end", seq, role: "assistant" });
      trace.record({ type: "run_end", reason: "done" });
      await trace.flush();
      log("info", "message blocked by guardrails", { guardrails: verdict.by.length });
      return;
    }
    for await (const event of deps.runtime.run(agentRun)) {
      if (event.type !== "message_end") {
        const safe =
          event.type === "run_end" && event.error !== undefined
            ? { ...event, error: scrub(event.error) }
            : event;
        await live.send(safe);
        if (safe.type === "run_end" && safe.reason === "refused") {
          await setLastError(ctx.db, conversationId, safe.error ?? "the request was refused");
        }
        const traced = traceOf(safe);
        if (traced) trace.record(traced);
        // Stored where something happened a crash must not erase: a tool started or finished, the run ended. The rest
        // waits for the next message to be persisted.
        if (safe.type === "tool_start" || safe.type === "tool_end" || safe.type === "run_end")
          await trace.flush();
        continue;
      }
      await live.flush();
      const seq = nextSeq;
      // Persist before act: the object, then the fenced index row, inside an Absurd step. The runtime does not
      // continue (and so runs no tool) until this returns and the next event is pulled.
      await run.step(`persist:${seq}`, () =>
        persistMessage(ctx, deps.blobs, { conversationId, seq, message: event.message, run }),
      );
      nextSeq = seq + 1;
      persisted++;
      if (event.message.role !== "user") {
        trace.record({ type: "message_end", seq, role: event.message.role });
        await trace.flush();
      }
      await meter(seq, event.message);
    }
    log("info", "turn completed", {
      durationMs: Math.round(performance.now() - started),
      messages: persisted,
      attempt: run.attempt,
    });
  } catch (caught) {
    const error =
      caught instanceof Error && apiKey && caught.message.includes(apiKey)
        ? new Error(scrub(caught.message))
        : caught;
    if (error instanceof LeaseLostError) {
      // Another worker owns this turn now; it will rehydrate from what is persisted. Write nothing more. An alert:
      // the lease outlived its heartbeat, so this worker stalled or lost the database for a claim timeout.
      alert("lease lost", { taskId: run.taskId });
      return;
    }
    if (error instanceof SeqConflictError) {
      log("warn", "a message position was taken by another run; abandoning", errorFields(error));
      return;
    }
    // An attempt that ends on an error says so in the trace; what it had buffered is stored with it. Best effort: the
    // error being thrown is the one that matters, and the next attempt's trace shows the retry. Bounded: a provider's
    // error can be long.
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    trace.record({ type: "run_error", error: scrub(reason) });
    await trace.flush().catch((flushError: unknown) => {
      log("warn", "could not record a failed run in the trace", errorFields(flushError));
    });
    // The last attempt failing for good leaves a trace on the conversation, unless this run is already superseded.
    const finalAttempt = run.maxAttempts !== null && run.attempt >= run.maxAttempts;
    if (finalAttempt && (await holdsRun(ctx.db, run).catch(() => false))) {
      alert("turn failed for good", { attempt: run.attempt, ...errorFields(error) });
      await setLastError(
        ctx.db,
        conversationId,
        `the turn failed after ${run.attempt} attempts`,
      ).catch(() => {});
    }
    throw error;
  }
}
