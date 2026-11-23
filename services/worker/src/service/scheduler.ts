// The tenant scheduler (ADR 0004): the worker learns of work from a NOTIFY on the control database, plus two sweeps
// as the backstop, and claims from a tenant's own database only while that tenant is under its concurrency limit,
// counted across every worker in the tenant's database (`TenantExecutor.claim`). A tenant at its limit on this worker
// alone costs nothing (no query), so a noisy tenant cannot delay another.
//
// Which tenants a sweep looks at (`tenant_wakeups` on control): the api marks a tenant due when it enqueues; after a
// claim, the worker records when the tenant's queue next needs a look (now, for work left over; a retry's backoff; a
// lease that lapses), unless a hint arrived since it read the hint's version. Every `sweepIntervalMs` the worker
// looks at the tenants that are due; every `fullSweepIntervalMs`, at start and when LISTEN reconnects, at every
// active tenant: a hint is lost if the api fails between its commit and its hint.
//
// The worker as a whole runs at most `maxRunningTurns` turns (each holds its tenant's connection pool, so this bounds
// the process's connections). Slots are reserved before a claim and a claim never takes more than it reserved, so a
// claimed task is always run. A tenant that asks while the worker is full waits in arrival order; each slot that frees
// goes to the longest-waiting tenant, not to whoever finished a turn, so a tenant with a deep queue cannot starve others.
import {
  getTenant,
  listDueTenants,
  listTenants,
  readWakeupVersion,
  settleTenantWakeup,
  type TenantRecord,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { createTenantExecutor, type TaskHandlers } from "@kerby/durable";
import { errorFields, log, withTenant } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";

/** Tenants looked at at once during a sweep (plan 0001, S4: about 20 is the sweet spot). */
const SWEEP_CONCURRENCY = 20;

/** `due`: the tenants whose work is due. `all`: every active tenant, the backstop for a lost hint. */
type SweepKind = "due" | "all";

export interface Scheduler {
  /** Look for work for one tenant now (a notification arrived). */
  notify(tenantId: string): void;
  /** Turns running for a tenant on this worker. */
  inFlight(tenantId: string): number;
  /** Subscribe to notifications, look at every active tenant once, then sweep on both intervals. */
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

type PumpOptions = {
  /** The tenant's record, when the caller just listed it. */
  known?: TenantRecord;
  /** A slot was reserved for this tenant when it reached the front of the queue. */
  granted?: boolean;
  /** Looking at many tenants as a backstop: a full worker neither looks nor queues the tenant. */
  sweep?: boolean;
};

export function createScheduler(
  deps: WorkerDeps,
  handlersFor: (ctx: TenantContext) => TaskHandlers,
): Scheduler {
  const { control, pools, settings } = deps;
  const cap = settings.maxRunningTurns;
  const running = new Map<string, number>();
  let runningTotal = 0;
  /** Slots promised to a claim in progress, or to a waiting tenant that is about to look: used, not free. */
  let reserved = 0;
  /** Tenants that asked while the worker was full, in arrival order. */
  const waiting = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  const live = new Set<Promise<void>>();
  let stopping = false;
  const timers: NodeJS.Timeout[] = [];
  const sweeping = new Map<SweepKind, Promise<void>>();
  let unsubscribe: (() => Promise<void>) | undefined;

  const free = () => cap - runningTotal - reserved;

  /** Hand every free slot to the longest-waiting tenants. A slot is held for the tenant until its pump looks. */
  function wake(): void {
    for (const tenantId of waiting) {
      if (stopping || free() <= 0) return;
      waiting.delete(tenantId);
      reserved++;
      void pump(tenantId, { granted: true });
    }
  }

  async function pumpOnce(
    tenantId: string,
    { known, granted, sweep }: PumpOptions = {},
  ): Promise<void> {
    // Reservations this pump holds: one for a granted turn at the front of the queue, then the claim's own.
    let grant = granted ? 1 : 0;
    let claimReserved = 0;
    try {
      if (stopping) return;
      const tenant = known ?? (await getTenant(control, tenantId));
      if (tenant?.status !== "active") return;
      const limit = limitOf(tenant, settings.defaultMaxConcurrentTurns);
      // Fast path: this worker alone is at the limit, so all workers together are too. The tenant stays due: a
      // finished turn here looks again, and so does the next sweep.
      const local = running.get(tenantId) ?? 0;
      if (local >= limit) return;

      reserved -= grant;
      grant = 0;
      const available = free();
      if (available <= 0) {
        // Full. A sweep looks at everyone and finds work another way; a notification or a finished turn queues.
        if (!sweep) waiting.add(tenantId);
        return;
      }
      // No await between reading `free()` and reserving: two pumps never reserve the same slot.
      claimReserved = Math.min(available, limit - local);
      reserved += claimReserved;

      // Read before the claim: a hint written after this read is newer than what the claim sees, so the settle
      // below leaves it due.
      const version = await readWakeupVersion(control, tenantId);
      const lease = await pools.acquire(tenantId);
      let remaining = 0;
      let nextDueAt: Date | null;
      try {
        const ctx: TenantContext = { tenantId, db: lease.db };
        const executor = createTenantExecutor(lease.db, handlersFor(ctx), {
          workerId: settings.workerId,
          claimTimeoutSeconds: settings.claimTimeoutSeconds,
          ...(settings.heartbeatEveryMs === undefined
            ? {}
            : { heartbeatEveryMs: settings.heartbeatEveryMs }),
        });
        const claimed = await executor.claim(limit, claimReserved);
        nextDueAt = claimed.nextDueAt;
        // Reservations turn into running turns in one step.
        reserved -= claimReserved;
        claimReserved = 0;
        remaining = claimed.tasks.length;
        for (const task of claimed.tasks) {
          running.set(tenantId, (running.get(tenantId) ?? 0) + 1);
          runningTotal++;
          const done = executor
            .execute(task)
            .finally(async () => {
              running.set(tenantId, (running.get(tenantId) ?? 1) - 1);
              runningTotal--;
              // A slot is free: the longest-waiting tenant gets it, and this tenant queues behind them if it has more.
              if (!stopping) {
                waiting.add(tenantId);
                wake();
              }
              if (--remaining === 0) await lease.release();
            })
            .catch(() => {});
          live.add(done);
          void done.finally(() => live.delete(done));
        }
      } finally {
        if (remaining === 0) await lease.release();
      }
      await settleTenantWakeup(control, tenantId, version, nextDueAt);
    } finally {
      reserved -= grant;
      reserved -= claimReserved;
      wake();
    }
  }

  /** One pump at a time per tenant: two claims racing would each see the same free slots. */
  function pump(tenantId: string, options?: PumpOptions): Promise<void> {
    const previous = chains.get(tenantId) ?? Promise.resolve();
    const next = previous
      .then(() => withTenant(tenantId, () => pumpOnce(tenantId, options)))
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

  /** Look at the tenants of one kind; a sweep of that kind already running is joined, not repeated. */
  function sweep(kind: SweepKind): Promise<void> {
    const current = sweeping.get(kind);
    if (current) return current;
    const next = (async () => {
      try {
        const tenants =
          kind === "due"
            ? await listDueTenants(control)
            : await listTenants(control, { status: "active" });
        const queue = [...tenants];
        const worker = async () => {
          for (let tenant = queue.shift(); tenant !== undefined; tenant = queue.shift()) {
            await pump(tenant.id, { known: tenant, sweep: true });
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(SWEEP_CONCURRENCY, tenants.length) }, worker),
        );
      } catch (error) {
        log("warn", "sweep failed", { sweep: kind, ...errorFields(error) });
      } finally {
        sweeping.delete(kind);
      }
    })();
    sweeping.set(kind, next);
    return next;
  }

  return {
    notify,
    inFlight: (tenantId) => running.get(tenantId) ?? 0,
    async start() {
      const subscription = await control.listen(
        "tenant_work",
        (payload) => notify(payload),
        // Notifications sent while disconnected are gone: look everywhere.
        { onReconnect: () => void sweep("all") },
      );
      unsubscribe = () => subscription.close();
      await sweep("all");
      for (const [kind, every] of [
        ["due", settings.sweepIntervalMs],
        ["all", settings.fullSweepIntervalMs],
      ] as const) {
        const timer = setInterval(() => void sweep(kind), every);
        timer.unref();
        timers.push(timer);
      }
    },
    async stop(graceMs = 10_000) {
      stopping = true;
      for (const timer of timers) clearInterval(timer);
      await unsubscribe?.();
      const drained = Promise.allSettled([...live]);
      const expired = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
      await Promise.race([drained, expired]);
    },
  };
}
