import type { TenantContext } from "@kerby/db";
import type { TaskHandlers } from "@kerby/durable";
import { withTenant } from "@kerby/observability";
import { runTurn } from "../service/turn.ts";
import type { WorkerDeps } from "../types/index.ts";

/** The Absurd task handlers for one tenant. Every log line inside a turn carries that tenant's id. */
export function createHandlers(deps: WorkerDeps): (ctx: TenantContext) => TaskHandlers {
  return (ctx) => ({
    "run-turn": (params, run) => withTenant(ctx.tenantId, () => runTurn(deps, ctx, params, run)),
  });
}
