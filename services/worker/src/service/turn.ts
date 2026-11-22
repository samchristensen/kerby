// The `run-turn` task body and its supervisor (ARCHITECTURE.md#durability-the-turn-lifecycle): rehydrate from the
// tenant's index, run through the AgentRuntime port, and persist every `message_end` before pulling the next event,
// which is what makes the runtime's "no tool before its message is stored" gate hold.
import type { AgentEvent, AgentRun, ToolResult } from "@kerby/agent";
import { parseModelId } from "@kerby/contracts";
import { recordUsage } from "@kerby/control-plane";
import {
  findConversation,
  LeaseLostError,
  notifyLive,
  persistMessage,
  readMessages,
  recordToolExecution,
  SeqConflictError,
  setLastError,
} from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext, type TaskParams } from "@kerby/durable";
import { alert, errorFields, log } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";
import { tenantTools } from "./tools.ts";

/** Live events are batched: text deltas arrive many times a second and each notification is a round trip. */
const DELTA_FLUSH_CHARS = 400;
const DELTA_FLUSH_MS = 100;

class LiveEvents {
  readonly #ctx: TenantContext;
  readonly #conversationId: string;
  readonly #runId: string;
  readonly #position: () => number;
  #pending = "";
  #lastFlush = 0;

  constructor(ctx: TenantContext, conversationId: string, runId: string, position: () => number) {
    this.#ctx = ctx;
    this.#conversationId = conversationId;
    this.#runId = runId;
    this.#position = position;
  }

  async send(event: AgentEvent): Promise<void> {
    if (event.type === "text_delta") {
      this.#pending += event.text;
      if (
        this.#pending.length >= DELTA_FLUSH_CHARS ||
        Date.now() - this.#lastFlush >= DELTA_FLUSH_MS
      ) {
        await this.flush();
      }
      return;
    }
    await this.flush();
    await this.#emit(event);
  }

  /** Send any held text now (before a persist, so clients see the text before the message that holds it). */
  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const text = this.#pending;
    this.#pending = "";
    this.#lastFlush = Date.now();
    await this.#emit({ type: "text_delta", text });
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

  // Rehydrate: everything persisted so far, and the position of the next message.
  const stored = await readMessages(ctx, deps.blobs, conversationId);
  let nextSeq = (stored.at(-1)?.seq ?? 0) + 1;
  const tools = tenantTools({ enableEcho: deps.settings.enableEchoTool });

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
    history: stored.map((s) => s.message),
    tools: tools.specs(),
    // The only way a tool runs: an Absurd step keyed by the call id, so a retried turn gets the stored result and
    // does not repeat a side effect. `recordToolExecution` counts real runs inside the step.
    executeTool: (call, signal): Promise<ToolResult> =>
      run.step(`tool:${call.id}`, async () => {
        await recordToolExecution(ctx.db, { conversationId, callId: call.id, name: call.name });
        return tools.execute(call, signal);
      }),
    readBlob: async (blobId) => (await deps.blobs.get(ctx, blobId)).body,
    signal: run.signal,
  };

  const live = new LiveEvents(ctx, conversationId, run.runId, () => nextSeq);
  try {
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
      if (event.message.role === "assistant" && event.message.usage) {
        const usage = event.message.usage;
        await recordUsage(deps.control, {
          tenantId: ctx.tenantId,
          dedupeKey: `${conversationId}:${seq}`,
          model: event.message.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd,
        });
      }
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
