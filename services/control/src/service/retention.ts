import { listTenants } from "@kerby/control-plane";
import { cleanup } from "@kerby/durable";
import { pruneEvents } from "@kerby/events";
import { alert, errorFields, log, withTenant } from "@kerby/observability";
import type { ControlDeps } from "../types/index.ts";

/** How long a tenant's events and delivery attempts stay readable (ADR 0019). */
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type RetentionRun = {
  tenants: number;
  events: number;
  attempts: number;
  tasks: number;
  failed: string[];
};

/**
 * Per live tenant: delete events and delivery attempts past retention, and Absurd's finished tasks past their queue's
 * TTL. Every instance may run it; the deletes are idempotent. A tenant's failure is logged and the rest go on.
 */
export async function pruneTenants(deps: ControlDeps): Promise<RetentionRun> {
  const run: RetentionRun = { tenants: 0, events: 0, attempts: 0, tasks: 0, failed: [] };
  for (const tenant of await listTenants(deps.control)) {
    if (tenant.status !== "active" && tenant.status !== "suspended") continue;
    try {
      await deps.pools.use(tenant.id, async (db) => {
        const pruned = await pruneEvents(db, EVENT_RETENTION_MS);
        run.events += pruned.events;
        run.attempts += pruned.attempts;
        run.tasks += await cleanup(db);
      });
      run.tenants++;
    } catch (error) {
      withTenant(tenant.id, () => log("error", "tenant retention failed", errorFields(error)));
      run.failed.push(tenant.id);
    }
  }
  const { failed, ...counts } = run;
  log("info", "tenant retention ran", { ...counts, failed: failed.length });
  if (failed.length > 0)
    alert("tenant retention failed", { failed: failed.length, firstFailedTenant: failed[0] });
  return run;
}
