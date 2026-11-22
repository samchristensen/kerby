// The tenant scheduler (ADR 0004): the worker learns of work from a NOTIFY on the control database (plus a periodic
// sweep as the backstop), and claims from a tenant's own database only while that tenant is under its concurrency
// limit, counted across every worker in the tenant's database (`TenantExecutor.claim`). A tenant at its limit on
// this worker alone costs nothing (no query), so a noisy tenant cannot delay another.
import { getTenant, listTenants, type TenantRecord } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { createTenantExecutor, type TaskHandlers } from "@kerby/durable";
import { errorFields, log, withTenant } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";

/** Tenants looked at at once during a sweep (plan 0001, S4: about 20 is the sweet spot). */
const SWEEP_CONCURRENCY = 20;

export interface Scheduler {
  /** Look for work for one tenant now (a notification arrived). */
  notify(tenantId: string): void;
  /** Look at every active tenant. */
  sweep(): Promise<void>;
  /** Turns running for a tenant on this worker. */
  inFlight(tenantId: string): number;
  /** Subscribe to notifications, sweep once, then sweep on an interval. */
  start(): Promise<void>;
  /** Stop claiming; wait up to `graceMs` for running turns, then return (their leases lapse for another worker). */
  stop(graceMs?: number): Promise<void>;
}

function limitOf(tenant: TenantRecord, fallback: number): number {
  const configured = tenant.limits.maxConcurrentTurns;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : fallback;
}

export function createScheduler(
  deps: WorkerDeps,
  handlersFor: (ctx: TenantContext) => TaskHandlers,
): Scheduler {
  const { control, pools, settings } = deps;
  const running = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  const live = new Set<Promise<void>>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;

  async function pumpOnce(tenantId: string, known?: TenantRecord): Promise<void> {
    if (stopping) return;
    const tenant = known ?? (await getTenant(control, tenantId));
    if (tenant?.status !== "active") return;
    const limit = limitOf(tenant, settings.defaultMaxConcurrentTurns);
    // Fast path: this worker alone is at the limit, so all workers together are too.
    if ((running.get(tenantId) ?? 0) >= limit) return;

    const lease = await pools.acquire(tenantId);
    let remaining = 0;
    try {
      const ctx: TenantContext = { tenantId, db: lease.db };
      const executor = createTenantExecutor(lease.db, handlersFor(ctx), {
        workerId: settings.workerId,
        claimTimeoutSeconds: settings.claimTimeoutSeconds,
        ...(settings.heartbeatEveryMs === undefined
          ? {}
          : { heartbeatEveryMs: settings.heartbeatEveryMs }),
      });
      const tasks = await executor.claim(limit);
      remaining = tasks.length;
      for (const task of tasks) {
        running.set(tenantId, (running.get(tenantId) ?? 0) + 1);
        const done = executor
          .execute(task)
          .finally(async () => {
            running.set(tenantId, (running.get(tenantId) ?? 1) - 1);
            if (--remaining === 0) await lease.release();
            // A slot is free: there may be more queued.
            if (!stopping) notify(tenantId);
          })
          .catch(() => {});
        live.add(done);
        void done.finally(() => live.delete(done));
      }
    } finally {
      if (remaining === 0) await lease.release();
    }
  }

  /** One pump at a time per tenant: two claims racing would each see the same free slots. */
  function pump(tenantId: string, known?: TenantRecord): Promise<void> {
    const previous = chains.get(tenantId) ?? Promise.resolve();
    const next = previous
      .then(() => withTenant(tenantId, () => pumpOnce(tenantId, known)))
      .catch((error: unknown) => {
        withTenant(tenantId, () => log("warn", "looking for work failed", errorFields(error)));
      });
    chains.set(tenantId, next);
    void next.finally(() => {
      if (chains.get(tenantId) === next) chains.delete(tenantId);
    });
    return next;
  }

  function notify(tenantId: string): void {
    void pump(tenantId);
  }

  async function sweep(): Promise<void> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        const tenants = await listTenants(control, { status: "active" });
        const queue = [...tenants];
        const worker = async () => {
          for (let tenant = queue.shift(); tenant !== undefined; tenant = queue.shift()) {
            await pump(tenant.id, tenant);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(SWEEP_CONCURRENCY, tenants.length) }, worker),
        );
      } catch (error) {
        log("warn", "sweep failed", errorFields(error));
      } finally {
        sweeping = undefined;
      }
    })();
    return sweeping;
  }

  return {
    notify,
    sweep,
    inFlight: (tenantId) => running.get(tenantId) ?? 0,
    async start() {
      const subscription = await control.listen(
        "tenant_work",
        (payload) => notify(payload),
        // Notifications sent while disconnected are gone: look everywhere.
        { onReconnect: () => void sweep() },
      );
      unsubscribe = () => subscription.close();
      await sweep();
      timer = setInterval(() => void sweep(), settings.sweepIntervalMs);
      timer.unref();
    },
    async stop(graceMs = 10_000) {
      stopping = true;
      clearInterval(timer);
      await unsubscribe?.();
      const drained = Promise.allSettled([...live]);
      const expired = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
      await Promise.race([drained, expired]);
    },
  };
}
