// Running a judgment (ADR 0015): the tenant's own key for the model's provider, opened for this call only, goes to the
// provider behind the JudgmentProvider port, and the usage is recorded once. Two callers share it: the `run-judgment`
// task (`POST /v1/judgments`) and the agent's `judge` tool.
import { DEFAULT_JUDGMENT_MODEL, parseModelId } from "@kerby/contracts";
import { hasModelKey, recordUsage } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext, type TaskParams } from "@kerby/durable";
import { announceEvents, type NewEvent, notifyDispatchers, recordEvent } from "@kerby/events";
import type { JudgmentOutcome, JudgmentRequest } from "@kerby/judgment";
import { errorFields, log } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";
import type { Judge } from "./tools.ts";

/**
 * Judge `request` with the provider its model names. `usageKey` makes the usage row once-only: the same key twice is
 * the same judgment (a retried task, a retried tool step). A refusal is an outcome; anything else the provider throws
 * propagates (scrubbed of the key) so the caller's retry runs again.
 */
export async function runJudgment(
  deps: WorkerDeps,
  tenantId: string,
  usageKey: string,
  request: JudgmentRequest,
  signal: AbortSignal,
): Promise<JudgmentOutcome> {
  const providerId = parseModelId(request.model)?.provider;
  if (!providerId)
    return {
      type: "refused",
      error: `model "${request.model}" must look like <provider>/<modelId>`,
    };
  const provider = deps.judgments.find((candidate) => candidate.id === providerId);
  if (!provider) {
    const known = deps.judgments.map((candidate) => candidate.id).join(", ");
    return { type: "refused", error: `no judgment provider "${providerId}"; supported: ${known}` };
  }
  // Bring your own key. The same request gets the same answer until the tenant adds one: a refusal, not a retry.
  const apiKey = deps.modelKeys ? await deps.modelKeys(tenantId, providerId) : undefined;
  if (!apiKey)
    return {
      type: "refused",
      error: `no model key for provider "${providerId}": PUT /v1/model-keys/${providerId}, then submit again`,
    };
  /** A provider's error can quote the key it rejected; nothing that leaves this function may. */
  const scrub = (text: string): string => text.replaceAll(apiKey, "[redacted]");

  let outcome: JudgmentOutcome;
  try {
    outcome = await provider.judge({ ...request, apiKey, signal });
  } catch (caught) {
    if (caught instanceof Error && caught.message.includes(apiKey))
      throw new Error(scrub(caught.message));
    throw caught;
  }
  if (outcome.type === "refused") return { type: "refused", error: scrub(outcome.error) };
  await recordUsage(deps.control, {
    tenantId,
    dedupeKey: usageKey,
    model: `${providerId}/${outcome.model}`,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
  });
  return outcome;
}

/**
 * The `run-judgment` task body. The provider is called inside a step, so a retry after a later failure gets the stored
 * outcome and does not ask (or pay) twice. The outcome is the task's result: `GET /v1/judgments/:id` reads it. The
 * provider gets the model, state and questions only: which prompt they came from is the api's record, not its business.
 */
export async function runJudgmentTask(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["run-judgment"],
  run: RunContext,
): Promise<JudgmentOutcome> {
  const started = performance.now();
  const request: JudgmentRequest = {
    model: params.model,
    state: params.state,
    questions: params.questions,
  };
  /** The judgment's one outcome event, fenced: a run that lost its task records nothing. */
  const record = async (event: NewEvent): Promise<void> => {
    const recorded = await ctx.db.transaction(
      async (tx) => (await holdsRun(tx, run)) && (await recordEvent(tx, event)),
    );
    if (recorded) await announceEvents(ctx.db);
    await notifyDispatchers(deps.control, ctx.tenantId);
  };
  const common = {
    integrationId: params.integrationId,
    dedupeKey: `judgment:${run.taskId}:outcome`,
  };
  let outcome: JudgmentOutcome;
  try {
    outcome = await run.step("judge", () =>
      runJudgment(deps, ctx.tenantId, `judgment:${run.taskId}`, request, run.signal),
    );
  } catch (error) {
    if (run.maxAttempts !== null && run.attempt >= run.maxAttempts) {
      // runJudgment already scrubbed the key from what it throws; bounded: a provider's error can be long.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      await record({
        ...common,
        type: "judgment.failed",
        data: { judgmentId: run.taskId, error: message },
      }).catch((recordError: unknown) => {
        log("warn", "could not record a failed judgment", errorFields(recordError));
      });
    }
    throw error;
  }
  await record({
    ...common,
    type: "judgment.completed",
    data: { judgmentId: run.taskId, status: outcome.type === "refused" ? "refused" : "answered" },
  });
  log("info", "judgment completed", {
    outcome: outcome.type,
    questions: Object.keys(request.questions).length,
    durationMs: Math.round(performance.now() - started),
    attempt: run.attempt,
  });
  return outcome;
}

/**
 * The agent's `judge` tool for a conversation, or undefined when the tenant has no key for the default judgment
 * provider (offering a tool that can only fail would invite the model to try it). Each call is its own judgment.
 */
export async function judgeTool(
  deps: WorkerDeps,
  tenantId: string,
  conversationId: string,
): Promise<Judge | undefined> {
  const provider = parseModelId(DEFAULT_JUDGMENT_MODEL)?.provider;
  if (!deps.modelKeys || !provider || !(await hasModelKey(deps.control, tenantId, provider)))
    return undefined;
  return (request, signal, callId) =>
    runJudgment(deps, tenantId, `judgment:${conversationId}:${callId}`, request, signal);
}
