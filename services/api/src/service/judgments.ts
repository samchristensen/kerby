// Judgments over HTTP (ADR 0015): `POST /v1/judgments` enqueues a `run-judgment` task and answers at once; a worker, the
// only process that can open the tenant's key, asks the provider and stores the outcome as the task's result;
// `GET /v1/judgments/:id` reads it back. The questions and model are written out, or come from a published decision
// prompt (ADR 0017), whose version the task records.
import { randomUUID } from "node:crypto";
import {
  DEFAULT_JUDGMENT_MODEL,
  type Judgment,
  JudgmentOutcomeSchema,
  type SubmitJudgmentRequest,
  type SubmitJudgmentResponse,
} from "@kerby/contracts";
import { hintTenantWork } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { readTask, spawnInTx, type TaskParams } from "@kerby/durable";
import { errorFields, log } from "@kerby/observability";
import { type ApiDeps, NotFoundError } from "../types/index.ts";
import { assertJudgmentModel } from "./models.ts";
import { resolveDecisionPrompt } from "./prompts.ts";

/** Enqueue the judgment and tell the workers there is work for this tenant. Refused when its provider or key is missing. */
export async function submitJudgment(
  deps: ApiDeps,
  ctx: TenantContext,
  body: SubmitJudgmentRequest,
): Promise<SubmitJudgmentResponse> {
  let params: TaskParams["run-judgment"];
  if ("prompt" in body) {
    const decision = await resolveDecisionPrompt(ctx, body.prompt);
    params = {
      model: decision.model ?? DEFAULT_JUDGMENT_MODEL,
      state: body.state,
      questions: decision.questions,
      prompt: decision.prompt,
    };
  } else {
    params = {
      model: body.model ?? DEFAULT_JUDGMENT_MODEL,
      state: body.state,
      questions: body.questions,
    };
  }
  await assertJudgmentModel(deps, ctx.tenantId, params.model);
  const { taskId } = await ctx.db.transaction((tx) =>
    spawnInTx(tx, "run-judgment", params, { idempotencyKey: `judgment:${randomUUID()}` }),
  );
  // After the commit, so a worker that sees the hint can claim the task. At-least-once: if the hint is lost, the
  // worker's full sweep finds the task.
  await hintTenantWork(deps.control, ctx.tenantId).catch((error: unknown) => {
    log(
      "warn",
      "could not hint workers; the full sweep will find the judgment",
      errorFields(error),
    );
  });
  return { id: taskId };
}

export async function getJudgment(ctx: TenantContext, id: string): Promise<Judgment> {
  const task = await readTask(ctx.db, "run-judgment", id);
  if (!task) throw new NotFoundError("judgment not found");
  const identity = {
    id: task.id,
    model: task.params.model,
    createdAt: task.createdAt.toISOString(),
    prompt: task.params.prompt ?? null,
  };
  switch (task.state) {
    // A sleeping task is a failed attempt waiting out its retry delay.
    case "pending":
    case "sleeping":
      return { ...identity, status: "pending" };
    case "running":
      return { ...identity, status: "running" };
    case "completed": {
      const outcome = JudgmentOutcomeSchema.parse(task.result);
      return outcome.type === "answered"
        ? {
            ...identity,
            status: "answered",
            servedModel: outcome.model,
            answers: outcome.answers,
            usage: outcome.usage,
          }
        : { ...identity, status: "refused", error: outcome.error };
    }
    case "failed":
    case "cancelled":
      // Absurd keeps the last attempt's error, which may quote a provider's words: the tenant gets the fact, the logs the rest.
      return {
        ...identity,
        status: "failed",
        error: "the judgment failed after several attempts; submit it again",
      };
  }
}
