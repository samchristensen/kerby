import type { TenantContext } from "@kerby/db";
import type { TaskHandlers } from "@kerby/durable";
import { withTenant } from "@kerby/observability";
import { runIndexBackfill, runIndexConversation, runSearchTask } from "../service/indexing.ts";
import { runJudgmentTask } from "../service/judgments.ts";
import type { WorkerQueue } from "../service/scheduler.ts";
import { runTurn } from "../service/turn.ts";
import type { WorkerDeps } from "../types/index.ts";

/** The Absurd task handlers for one tenant, every lane's. Every log line inside a task carries that tenant's id. */
export function createHandlers(
  deps: WorkerDeps,
): (ctx: TenantContext) => TaskHandlers<WorkerQueue> {
  return (ctx) => ({
    "run-turn": (params, run) => withTenant(ctx.tenantId, () => runTurn(deps, ctx, params, run)),
    "run-judgment": (params, run) =>
      withTenant(ctx.tenantId, () => runJudgmentTask(deps, ctx, params, run)),
    "index-conversation": (params, run) =>
      withTenant(ctx.tenantId, () => runIndexConversation(deps, ctx, params, run)),
    "index-backfill": (params, run) =>
      withTenant(ctx.tenantId, () => runIndexBackfill(deps, ctx, params, run)),
    "run-search": (params, run) =>
      withTenant(ctx.tenantId, () => runSearchTask(deps, ctx, params, run)),
  });
}
