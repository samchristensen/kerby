// The tenant scheduler (ADR 0004): the worker learns of work from a NOTIFY on the control database (plus a periodic
// sweep as the backstop), and claims from a tenant's own database only while that tenant is under its concurrency
// limit, counted across every worker in the tenant's database (`TenantExecutor.claim`). A tenant at its limit on
// this worker alone costs nothing (no query), so a noisy tenant cannot delay another.
//
// Each queue has a lane with its own limits (ADR 0019): `turns` (the tenant's `maxConcurrentTurns`, the worker's
// `maxRunningTurns`), `index` (1 per tenant, `maxRunningIndexTasks`) and `search` (4 per tenant, `maxRunningSearches`),
// so indexing and searches never take a turn's slot, nor turns theirs. A notification does not say which queue has
// work, so a tenant's pump looks at every lane; one pump at a time per tenant.
//
// A lane runs at most its cap of tasks at once on this worker (each holds its tenant's connection pool, so the caps
// bound the process's connections). Slots are reserved before a claim and a claim never takes more than it reserved,
// so a claimed task is always run. A tenant that asks while a lane is full waits in that lane in arrival order; each
// slot that frees goes to the lane's longest-waiting tenant, not to whoever finished a task, so a tenant with a deep
// queue cannot starve others.
import { getTenant, listTenants, type TenantRecord } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { createTenantExecutor, type Queue, type TaskHandlers } from "@kerby/durable";
import { errorFields, log, withTenant } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";

/** Tenants looked at at once during a sweep (plan 0001, S4: about 20 is the sweet spot). */
const SWEEP_CONCURRENCY = 20;
/** Index tasks one tenant runs at once: indexing is background work, and one keeps a backfill off its database. */
const INDEX_TASKS_PER_TENANT = 1;
/** Searches one tenant runs at once. */
const SEARCHES_PER_TENANT = 4;

export interface Scheduler {
  /** Look for work for one tenant now (a notification arrived). */
  notify(tenantId: string): void;
  /** Look at every active tenant. */
  sweep(): Promise<void>;
  /** Tasks of `queue` (default `turns`) running for a tenant on this worker. */
  inFlight(tenantId: string, queue?: Queue): number;
  /** Subscribe to notifications, sweep once, then sweep on an interval. */
  start(): Promise<void>;
  /** Stop claiming; wait up to `graceMs` for running tasks, then return (their leases lapse for another worker). */
  stop(graceMs?: number): Promise<void>;
}

function turnLimitOf(tenant: TenantRecord, fallback: number): number {
  const configured = tenant.limits.maxConcurrentTurns;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : fallback;
}

/** One queue's share of the worker. */
type Lane = {
  queue: Queue;
  /** Tasks of the queue one tenant may run at once, counted across every worker. */
  limitOf: (tenant: TenantRecord) => number;
  /** Tasks of the queue this worker runs at once across every tenant. */
  cap: number;
  running: Map<string, number>;
  runningTotal: number;
  /** Slots promised to a claim in progress, or to a waiting tenant that is about to look: used, not free. */
  reserved: number;
  /** Tenants that asked while the lane was full, in arrival order. */
  waiting: Set<string>;
};

const emptyLane = (queue: Queue, cap: number, limitOf: Lane["limitOf"]): Lane => ({
  queue,
  limitOf,
  cap,
  running: new Map(),
  runningTotal: 0,
  reserved: 0,
  waiting: new Set(),
});

type PumpOptions = {
  /** The tenant's record, when the caller just listed it. */
  known?: TenantRecord;
  /** The lane that reserved a slot for this tenant at the front of its queue: the pump looks there only. */
  granted?: Lane;
  /** Looking at everyone as a backstop: a full lane neither looks nor queues the tenant. */
  sweep?: boolean;
};

export function createScheduler(
  deps: WorkerDeps,
  handlersFor: (ctx: TenantContext) => TaskHandlers,
): Scheduler {
  const { control, pools, settings } = deps;
  const lanes: readonly Lane[] = [
    emptyLane("turns", settings.maxRunningTurns, (tenant) =>
      turnLimitOf(tenant, settings.defaultMaxConcurrentTurns),
    ),
    emptyLane("index", settings.maxRunningIndexTasks, () => INDEX_TASKS_PER_TENANT),
    emptyLane("search", settings.maxRunningSearches, () => SEARCHES_PER_TENANT),
  ];
  const chains = new Map<string, Promise<void>>();
  const live = new Set<Promise<void>>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;

  const free = (lane: Lane) => lane.cap - lane.runningTotal - lane.reserved;

  /** Hand every free slot of `lane` to its longest-waiting tenants. A slot is held for the tenant until it looks. */
  function wake(lane: Lane): void {
    for (const tenantId of lane.waiting) {
      if (stopping || free(lane) <= 0) return;
      lane.waiting.delete(tenantId);
      lane.reserved++;
      void pump(tenantId, { granted: lane });
    }
  }

  /** Claim the tenant's tasks on one lane, as many as its limit and the lane's free slots allow, and start them. */
  async function look(
    tenantId: string,
    tenant: TenantRecord,
    lane: Lane,
    { granted, sweep }: { granted: boolean; sweep: boolean },
  ): Promise<void> {
    // Reservations this look holds: one for a granted slot at the front of the queue, then the claim's own.
    let grant = granted ? 1 : 0;
    let claimReserved = 0;
    try {
      if (stopping) return;
      const limit = lane.limitOf(tenant);
      // Fast path: this worker alone is at the limit, so all workers together are too.
      const local = lane.running.get(tenantId) ?? 0;
      if (local >= limit) return;

      lane.reserved -= grant;
      grant = 0;
      const available = free(lane);
      if (available <= 0) {
        // Full. A sweep looks at everyone and finds work another way; a notification or a finished task queues.
        if (!sweep) lane.waiting.add(tenantId);
        return;
      }
      // No await between reading `free` and reserving: two pumps never reserve the same slot.
      claimReserved = Math.min(available, limit - local);
      lane.reserved += claimReserved;

      const lease = await pools.acquire(tenantId);
      let remaining = 0;
      try {
        const ctx: TenantContext = { tenantId, db: lease.db };
        const executor = createTenantExecutor(lease.db, handlersFor(ctx), {
          workerId: settings.workerId,
          queue: lane.queue,
          claimTimeoutSeconds: settings.claimTimeoutSeconds,
          ...(settings.heartbeatEveryMs === undefined
            ? {}
            : { heartbeatEveryMs: settings.heartbeatEveryMs }),
        });
        const tasks = await executor.claim(limit, claimReserved);
        // Reservations turn into running tasks in one step.
        lane.reserved -= claimReserved;
        claimReserved = 0;
        remaining = tasks.length;
        for (const task of tasks) {
          lane.running.set(tenantId, (lane.running.get(tenantId) ?? 0) + 1);
          lane.runningTotal++;
          const done = executor
            .execute(task)
            .finally(async () => {
              lane.running.set(tenantId, (lane.running.get(tenantId) ?? 1) - 1);
              lane.runningTotal--;
              // A slot is free: the longest-waiting tenant gets it, and this tenant queues behind them if it has more.
              if (!stopping) {
                lane.waiting.add(tenantId);
                wake(lane);
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
    } finally {
      lane.reserved -= grant;
      lane.reserved -= claimReserved;
      wake(lane);
    }
  }

  async function pumpOnce(
    tenantId: string,
    { known, granted, sweep = false }: PumpOptions = {},
  ): Promise<void> {
    // The granted slot, released here unless the look at its lane takes it over.
    let grant = granted;
    try {
      if (stopping) return;
      const tenant = known ?? (await getTenant(control, tenantId));
      if (tenant?.status !== "active") return;
      grant = undefined;
      // A granted slot is for more of its lane's work; a notification or a sweep may be about any queue.
      for (const lane of granted ? [granted] : lanes) {
        try {
          await look(tenantId, tenant, lane, { granted: lane === granted, sweep });
        } catch (error) {
          // One lane failing (a tenant database not yet migrated to its queue) leaves the others working.
          log("warn", "looking for work failed", { queue: lane.queue, ...errorFields(error) });
        }
      }
    } finally {
      if (grant) {
        grant.reserved--;
        wake(grant);
      }
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

  async function sweep(): Promise<void> {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        const tenants = await listTenants(control, { status: "active" });
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
    inFlight: (tenantId, queue = "turns") =>
      lanes.find((lane) => lane.queue === queue)?.running.get(tenantId) ?? 0,
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
