// The tenant scheduler (ADR 0004): the worker learns of work from a NOTIFY on the control database, plus two sweeps
// as the backstop, and claims from a tenant's own database only while that tenant is under its concurrency limit,
// counted across every worker in the tenant's database (`TenantExecutor.claim`). A tenant at its limit on this worker
// alone costs nothing (no query), so a noisy tenant cannot delay another.
//
// Which tenants a sweep looks at (`tenant_wakeups` on control): the api marks a tenant due when it enqueues; after a
// claim, the worker records when the tenant's queues next need a look (now, for work left over; a retry's backoff; a
// lease that lapses), unless a hint arrived since it read the hint's version. Every `sweepIntervalMs` the worker
// looks at the tenants that are due; every `fullSweepIntervalMs`, at start and when LISTEN reconnects, at every
// active tenant: a hint is lost if the api fails between its commit and its hint.
//
// Each queue has a lane with its own limits (ADR 0021): `turns` (the tenant's `maxConcurrentTurns`, the worker's
// `maxRunningTurns`), `index` (1 per tenant, `maxRunningIndexTasks`) and `search` (4 per tenant, `maxRunningSearches`),
// so indexing and searches never take a turn's slot, nor turns theirs. A hint does not say which queue has work, so
// every pump looks at every lane (a slot granted at the front of a lane's queue is for that lane only); one pump at a
// time per tenant. The wakeup is one per tenant: it is settled with the earliest time any lane needs, and a lane the
// pump skipped (at its limit, full) leaves the tenant due, as a skipped tenant always has.
//
// A lane runs at most its cap of tasks at once on this worker (each holds its tenant's connection pool, so the caps
// bound the process's connections). Slots are reserved before a claim and a claim never takes more than it reserved,
// so a claimed task is always run. A tenant that asks while a lane is full waits in that lane in arrival order; each
// slot that frees goes to the lane's longest-waiting tenant, not to whoever finished a task, so a tenant with a deep
// queue cannot starve others.
import {
  getTenant,
  listDueTenants,
  listTenants,
  readWakeupVersion,
  settleTenantWakeup,
  type TenantRecord,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { createTenantExecutor, handlersOn, type TaskHandlers } from "@kerby/durable";
import { errorFields, log, withTenant } from "@kerby/observability";
import type { WorkerDeps } from "../types/index.ts";

/** Tenants looked at at once during a sweep (plan 0001, S4: about 20 is the sweet spot). */
const SWEEP_CONCURRENCY = 20;
/** Index tasks one tenant runs at once: indexing is background work, and one keeps a backfill off its database. */
const INDEX_TASKS_PER_TENANT = 1;
/** Searches one tenant runs at once. */
const SEARCHES_PER_TENANT = 4;

/** The queues the worker serves, a lane each. */
export type WorkerQueue = "turns" | "index" | "search";

/** `due`: the tenants whose work is due. `all`: every active tenant, the backstop for a lost hint. */
type SweepKind = "due" | "all";

export interface Scheduler {
  /** Look for work for one tenant now (a notification arrived). */
  notify(tenantId: string): void;
  /** Tasks of `queue` (default `turns`) running for a tenant on this worker. */
  inFlight(tenantId: string, queue?: WorkerQueue): number;
  /** Subscribe to notifications, look at every active tenant once, then sweep on both intervals. */
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
  queue: WorkerQueue;
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

const emptyLane = (queue: WorkerQueue, cap: number, limitOf: Lane["limitOf"]): Lane => ({
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
  /** The lane that reserved a slot for this tenant at the front of its queue; the pump looks at the others too. */
  granted?: Lane;
  /** Looking at many tenants as a backstop: a full lane neither looks nor queues the tenant. */
  sweep?: boolean;
};

/** What a look at one lane learned: when its queue next needs a look (null: nothing waits), or nothing (skipped). */
type LaneLook = { nextDueAt: Date | null } | undefined;

export function createScheduler(
  deps: WorkerDeps,
  handlersFor: (ctx: TenantContext) => TaskHandlers<WorkerQueue>,
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
  const timers: NodeJS.Timeout[] = [];
  const sweeping = new Map<SweepKind, Promise<void>>();
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

  /**
   * Claim the tenant's tasks on one lane, as many as its limit and the lane's free slots allow, and start them.
   * `versionBeforeClaim` reads the tenant's hint version once per pump, before its first claim.
   */
  async function look(
    tenantId: string,
    tenant: TenantRecord,
    lane: Lane,
    versionBeforeClaim: () => Promise<string>,
    { granted, sweep }: { granted: boolean; sweep: boolean },
  ): Promise<LaneLook> {
    // Reservations this look holds: one for a granted slot at the front of the queue, then the claim's own.
    let grant = granted ? 1 : 0;
    let claimReserved = 0;
    try {
      if (stopping) return undefined;
      const limit = lane.limitOf(tenant);
      // Fast path: this worker alone is at the limit, so all workers together are too. The tenant stays due: a
      // finished task here looks again, and so does the next sweep.
      const local = lane.running.get(tenantId) ?? 0;
      if (local >= limit) return undefined;

      lane.reserved -= grant;
      grant = 0;
      const available = free(lane);
      if (available <= 0) {
        // Full. A sweep looks at everyone and finds work another way; a notification or a finished task queues.
        if (!sweep) lane.waiting.add(tenantId);
        return undefined;
      }
      // No await between reading `free` and reserving: two pumps never reserve the same slot.
      claimReserved = Math.min(available, limit - local);
      lane.reserved += claimReserved;

      await versionBeforeClaim();
      const lease = await pools.acquire(tenantId);
      let remaining = 0;
      let nextDueAt: Date | null;
      try {
        const ctx: TenantContext = { tenantId, db: lease.db };
        const executor = createTenantExecutor(lease.db, handlersOn(handlersFor(ctx), lane.queue), {
          workerId: settings.workerId,
          queue: lane.queue,
          claimTimeoutSeconds: settings.claimTimeoutSeconds,
          ...(settings.heartbeatEveryMs === undefined
            ? {}
            : { heartbeatEveryMs: settings.heartbeatEveryMs }),
        });
        const claimed = await executor.claim(limit, claimReserved);
        nextDueAt = claimed.nextDueAt;
        // Reservations turn into running tasks in one step.
        lane.reserved -= claimReserved;
        claimReserved = 0;
        remaining = claimed.tasks.length;
        for (const task of claimed.tasks) {
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
      return { nextDueAt };
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
      // Read before the first claim: a hint written after this read is newer than what the claims see, so the settle
      // below leaves it due.
      let version: Promise<string> | undefined;
      const versionBeforeClaim = () => {
        version ??= readWakeupVersion(control, tenantId);
        return version;
      };
      // Every lane, every time: a hint does not say which queue has work, and the wakeup is settled from all of them.
      // A granted slot is for its own lane only.
      const looked: LaneLook[] = [];
      for (const lane of lanes) {
        try {
          looked.push(
            await look(tenantId, tenant, lane, versionBeforeClaim, {
              granted: lane === granted,
              sweep,
            }),
          );
        } catch (error) {
          // One lane failing (a tenant database not yet migrated to its queue) leaves the others working.
          log("warn", "looking for work failed", { queue: lane.queue, ...errorFields(error) });
          looked.push(undefined);
        }
      }
      // A lane skipped (at its limit, full) or failed says nothing about when it is due: the tenant stays due.
      if (version === undefined || looked.some((result) => result === undefined)) return;
      const due = looked
        .map((result) => result?.nextDueAt)
        .filter((at): at is Date => at instanceof Date);
      const nextDueAt =
        due.length === 0 ? null : new Date(Math.min(...due.map((at) => at.getTime())));
      await settleTenantWakeup(control, tenantId, await version, nextDueAt);
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
    inFlight: (tenantId, queue = "turns") =>
      lanes.find((lane) => lane.queue === queue)?.running.get(tenantId) ?? 0,
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
