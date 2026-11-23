// The delivery scheduler (ADR 0019), the worker's shape (services/worker/src/service/scheduler.ts): the dispatcher
// learns of new events from a NOTIFY `tenant_events` on the control database (sent after an event commits), plus a
// periodic sweep of every tenant with subscriptions as the backstop. Each look at a tenant first fans its new events out
// into `deliver-events` tasks, then claims from the `deliveries` queue while the tenant is under its concurrency limit
// (`limits.concurrentDeliveries`), counted across every dispatcher in the tenant's database.
//
// The process runs at most `maxRunningDeliveries` deliveries (each holds its tenant's connection pool). Slots are
// reserved before a claim and a claim never takes more than it reserved; a tenant that asks while the dispatcher is full
// waits in arrival order, and each slot that frees goes to the longest-waiting tenant, so a slow endpoint with a deep
// queue cannot starve another tenant.
import {
  getTenant,
  hasSubscriptions,
  listTenantsWithSubscriptions,
  type TenantRecord,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { createTenantExecutor, type TaskHandlers } from "@kerby/durable";
import { eventsHeldBack } from "@kerby/events";
import { errorFields, log, withTenant } from "@kerby/observability";
import type { DispatcherDeps } from "../types/index.ts";
import { fanOut } from "./fanout.ts";

/**
 * When committed events wait behind an older open transaction (the horizon, ADR 0019), their notification has already
 * come and gone: look again after this, doubling while they stay held, up to the sweep interval.
 */
const HELD_BACK_FIRST_RECHECK_MS = 250;

/** Tenants looked at at once during a sweep, as the worker's. */
const SWEEP_CONCURRENCY = 20;

export interface Scheduler {
  /** Look for events and deliveries of one tenant now (a notification arrived). */
  notify(tenantId: string): void;
  /** Look at every tenant with subscriptions. */
  sweep(): Promise<void>;
  /** Deliveries running for a tenant in this dispatcher. */
  inFlight(tenantId: string): number;
  /** Subscribe to notifications, sweep once, then sweep on an interval. */
  start(): Promise<void>;
  /** Stop claiming; wait up to `graceMs` for running deliveries, then return (their leases lapse for another). */
  stop(graceMs?: number): Promise<void>;
}

function limitOf(tenant: TenantRecord, fallback: number): number {
  const configured = tenant.limits.concurrentDeliveries;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : fallback;
}

type PumpOptions = {
  /** A slot was reserved for this tenant when it reached the front of the queue. */
  granted?: boolean;
  /** Looking at everyone as a backstop: a full dispatcher neither looks nor queues the tenant. */
  sweep?: boolean;
};

export function createScheduler(
  deps: DispatcherDeps,
  handlersFor: (ctx: TenantContext) => TaskHandlers<"deliveries">,
): Scheduler {
  const { control, pools, settings } = deps;
  const cap = settings.maxRunningDeliveries;
  const running = new Map<string, number>();
  let runningTotal = 0;
  /** Slots promised to a claim in progress, or to a waiting tenant that is about to look: used, not free. */
  let reserved = 0;
  /** Tenants that asked while the dispatcher was full, in arrival order. */
  const waiting = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  const live = new Set<Promise<void>>();
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> | undefined;
  let unsubscribe: (() => Promise<void>) | undefined;
  /** Tenants whose committed events wait above the horizon: whether a look is scheduled, and the next delay. */
  const rechecks = new Map<string, { scheduled: boolean; delayMs: number }>();

  /** Look at a tenant again soon, because committed events are not readable yet; backs off while they stay held. */
  function recheck(tenantId: string): void {
    const state = rechecks.get(tenantId) ?? {
      scheduled: false,
      delayMs: HELD_BACK_FIRST_RECHECK_MS,
    };
    if (stopping || state.scheduled) return;
    rechecks.set(tenantId, { scheduled: true, delayMs: state.delayMs });
    setTimeout(() => {
      rechecks.set(tenantId, {
        scheduled: false,
        delayMs: Math.min(state.delayMs * 2, settings.sweepIntervalMs),
      });
      notify(tenantId);
    }, state.delayMs).unref();
  }

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

  async function pumpOnce(tenantId: string, { granted, sweep }: PumpOptions = {}): Promise<void> {
    let grant = granted ? 1 : 0;
    let claimReserved = 0;
    try {
      if (stopping) return;
      const tenant = await getTenant(control, tenantId);
      if (tenant?.status !== "active") return;
      // Every tenant's events notify; only one with subscriptions has anything to fan out or deliver.
      if (!(await hasSubscriptions(control, tenantId))) return;
      const limit = limitOf(tenant, settings.defaultConcurrentDeliveries);
      // This dispatcher alone is at the limit: a delivery that finishes looks again, fan-out included.
      const local = running.get(tenantId) ?? 0;
      if (local >= limit) return;

      reserved -= grant;
      grant = 0;
      const available = free();
      if (available <= 0) {
        if (!sweep) waiting.add(tenantId);
        return;
      }
      // No await between reading `free()` and reserving: two pumps never reserve the same slot.
      claimReserved = Math.min(available, limit - local);
      reserved += claimReserved;

      const lease = await pools.acquire(tenantId);
      let remaining = 0;
      try {
        const ctx: TenantContext = { tenantId, db: lease.db };
        // New events become tasks first, so this claim can already take them.
        try {
          const queued = await fanOut(deps, ctx);
          if (queued > 0) log("debug", "events fanned out", { events: queued });
          if (await eventsHeldBack(lease.db)) recheck(tenantId);
          else rechecks.delete(tenantId);
        } catch (error) {
          log("warn", "fan-out failed; the next look retries it", errorFields(error));
        }
        const executor = createTenantExecutor(lease.db, handlersFor(ctx), {
          queue: "deliveries",
          workerId: settings.workerId,
          claimTimeoutSeconds: settings.claimTimeoutSeconds,
          ...(settings.heartbeatEveryMs === undefined
            ? {}
            : { heartbeatEveryMs: settings.heartbeatEveryMs }),
        });
        const { tasks } = await executor.claim(limit, claimReserved);
        reserved -= claimReserved;
        claimReserved = 0;
        remaining = tasks.length;
        for (const task of tasks) {
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
        withTenant(tenantId, () =>
          log("warn", "looking for deliveries failed", errorFields(error)),
        );
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
        const queue = await listTenantsWithSubscriptions(control);
        const count = queue.length;
        const worker = async () => {
          for (let tenantId = queue.shift(); tenantId !== undefined; tenantId = queue.shift()) {
            await pump(tenantId, { sweep: true });
          }
        };
        await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, count) }, worker));
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
      const subscription = await control.listen("tenant_events", (payload) => notify(payload), {
        // Notifications sent while disconnected are gone: look everywhere.
        onReconnect: () => void sweep(),
      });
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
