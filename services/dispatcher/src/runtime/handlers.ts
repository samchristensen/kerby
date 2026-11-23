import type { TenantContext } from "@kerby/db";
import type { TaskHandlers } from "@kerby/durable";
import { withTenant } from "@kerby/observability";
import { deliverEvents } from "../service/deliver.ts";
import type { DispatcherDeps } from "../types/index.ts";

/** The `deliveries` queue's handlers for one tenant. Every log line inside a delivery carries that tenant's id. */
export function createHandlers(
  deps: DispatcherDeps,
): (ctx: TenantContext) => TaskHandlers<"deliveries"> {
  return (ctx) => ({
    "deliver-events": (params, run) =>
      withTenant(ctx.tenantId, () => deliverEvents(deps, ctx, params, run)),
  });
}
