// Judgments over HTTP (ADR 0015): `POST /v1/judgments` enqueues a `run-judgment` task and answers at once; a worker, the
// only process that can open the tenant's key, asks the provider and stores the outcome as the task's result;
// `GET /v1/judgments/:id` reads it back.
import { randomUUID } from "node:crypto";
import {
  DEFAULT_JUDGMENT_MODEL,
  type Judgment,
  JudgmentOutcomeSchema,
  type JudgmentRequestBody,
  type SubmitJudgmentResponse,
} from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import { readTask, spawnInTx } from "@kerby/durable";
import { errorFields, log } from "@kerby/observability";
import { type ApiDeps, NotFoundError } from "../types/index.ts";
import { assertJudgmentModel } from "./models.ts";

/** Enqueue the judgment and tell the workers there is work for this tenant. Refused when its provider or key is missing. */
export async function submitJudgment(
  deps: ApiDeps,
  ctx: TenantContext,
  body: JudgmentRequestBody,
): Promise<SubmitJudgmentResponse> {
  const model = body.model ?? DEFAULT_JUDGMENT_MODEL;
  await assertJudgmentModel(deps, ctx.tenantId, model);
  const { taskId } = await ctx.db.transaction((tx) =>
    spawnInTx(
      tx,
      "run-judgment",
      { model, state: body.state, questions: body.questions },
      { idempotencyKey: `judgment:${randomUUID()}` },
    ),
  );
  // At-least-once: the worker's periodic sweep finds the task even if this notification is lost.
  await deps.control
    .query("select pg_notify('tenant_work', $1)", [ctx.tenantId])
    .catch((error: unknown) => {
      log("warn", "could not notify workers; the sweep will find the judgment", errorFields(error));
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
