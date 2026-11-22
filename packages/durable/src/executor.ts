// Claim and run tasks from one tenant's database. The worker's tenant scheduler decides whom to claim for;
// this module does the claiming (within the tenant's limit across every worker), the lease heartbeat for the
// whole run, and fencing.
//
// Facts from plan 0001 S2 that shape it:
//  - A lapsed lease lets a second worker claim while the first still runs; the first only fails at its next step.
//    So: heartbeat every claimTimeout/3 for as long as the handler runs, and fence every write that is not a step.
//  - `fatalOnLeaseTimeout` defaults to killing the whole process, with every tenant's runs. It is always off here.
import { AsyncLocalStorage } from "node:async_hooks";
import { rawPool, type TenantDb, type TenantQueryable, withConnectRetry } from "@kerby/db";
import { errorFields, log } from "@kerby/observability";
import { Absurd, type ClaimedTask } from "absurd-sdk";
import { type Queue, TASKS, type TaskName, type TaskParams } from "./tasks.ts";

/** What a running task knows about itself. */
export type RunContext = {
  taskId: string;
  /** This attempt. A write that must not outlive it is fenced with `holdsRun`. */
  runId: string;
  attempt: number;
  /** Attempts the task may have in all (null: unbounded). The last one failing fails the task for good. */
  maxAttempts: number | null;
  queue: Queue;
  /** Aborted when the lease is lost: stop at once, the task belongs to another run now. */
  signal: AbortSignal;
  /** Run `fn` once per task: a retry gets the stored result. The value must be small JSON. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
};

export type TaskHandlers = {
  [N in TaskName]: (params: TaskParams[N], run: RunContext) => Promise<void>;
};

export type ClaimedRun = ClaimedTask;

export type ExecutorOptions = {
  /** Identifies this worker in Absurd's run rows. */
  workerId: string;
  /** Lease length in seconds (default 120). Heartbeats extend it for as long as a handler runs. */
  claimTimeoutSeconds?: number;
  /** How often to extend the lease. Default a third of the lease. Tests lengthen it to let a lease lapse. */
  heartbeatEveryMs?: number;
};

export interface TenantExecutor {
  /**
   * Claim runnable tasks while fewer than `limit` of this tenant's turns run, counted across every worker on the
   * tenant's database. Each claimed task must be passed to `execute`.
   */
  claim(limit: number): Promise<ClaimedRun[]>;
  /** Run a claimed task to completion. Never throws: failures are recorded on the task and retried by Absurd. */
  execute(task: ClaimedRun): Promise<void>;
}

const absurdLog = {
  log: (message: unknown) => log("debug", String(message)),
  info: (message: unknown) => log("info", String(message)),
  warn: (message: unknown) => log("warn", String(message)),
  error: (message: unknown, error?: unknown) =>
    log("error", String(message), error === undefined ? {} : errorFields(error)),
};

type Claim = { task: ClaimedRun; signal: AbortSignal; abort: (reason: Error) => void };
const claims = new AsyncLocalStorage<Claim>();

/** The queue whose running tasks count against a tenant's concurrency limit. */
const QUEUE = "turns";
/** Serializes claims within one tenant database (an advisory lock is scoped to its database). Any constant works. */
const CLAIM_LOCK = 7_271_001;

export function createTenantExecutor(
  db: TenantDb,
  handlers: Partial<TaskHandlers>,
  options: ExecutorOptions,
): TenantExecutor {
  const claimTimeout = options.claimTimeoutSeconds ?? 120;
  const heartbeatEvery = options.heartbeatEveryMs ?? (claimTimeout * 1000) / 3;
  const pool = rawPool(db);
  const absurd = new Absurd({ db: pool, queueName: QUEUE, log: absurdLog });

  for (const [name, handler] of Object.entries(handlers) as [
    TaskName,
    (params: never, run: RunContext) => Promise<void>,
  ][]) {
    absurd.registerTask({ name, queue: TASKS[name].queue }, async (params, ctx) => {
      const claim = claims.getStore();
      if (!claim) throw new Error(`task ${name} ran outside TenantExecutor.execute`);
      const timer = setInterval(() => {
        ctx.heartbeat(claimTimeout).catch((error: unknown) => {
          // The lease is gone (the task failed or was claimed elsewhere): tell the handler to stop.
          log("warn", "lease heartbeat failed; aborting run", {
            taskName: name,
            taskId: claim.task.task_id,
            ...errorFields(error),
          });
          claim.abort(error instanceof Error ? error : new Error("heartbeat failed"));
          clearInterval(timer);
        });
      }, heartbeatEvery);
      timer.unref();
      try {
        await handler(params as never, {
          taskId: claim.task.task_id,
          runId: claim.task.run_id,
          attempt: claim.task.attempt,
          maxAttempts: claim.task.max_attempts,
          queue: TASKS[name].queue,
          signal: claim.signal,
          step: (stepName, fn) => ctx.step(stepName, fn),
        });
      } finally {
        clearInterval(timer);
      }
    });
  }

  return {
    async claim(limit) {
      if (limit <= 0) return [];
      // Count and claim in one transaction holding a per-database lock: every worker's claim for this tenant waits
      // its turn and sees the runs the previous one committed. A lapsed lease no longer counts; the claim below
      // fails that run and may hand its task to this worker.
      const client = await withConnectRetry(() => pool.connect());
      // A checked-out client has no pool error listener: a connection cut while it waits on the lock must not crash
      // the process. The failure reaches the pending query, which throws below.
      const onError = (error: Error) => log("warn", "claim connection failed", errorFields(error));
      client.on("error", onError);
      let broken: Error | undefined;
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock($1)", [CLAIM_LOCK]);
        const { rows } = await client.query<{ running: number }>(
          `select count(*)::int as running from absurd.r_${QUEUE}
            where state = 'running' and claim_expires_at > clock_timestamp()`,
        );
        const free = limit - (rows[0]?.running ?? 0);
        const tasks =
          free > 0
            ? await absurd
                .bindToConnection(client)
                .claimTasks({ batchSize: free, claimTimeout, workerId: options.workerId })
            : [];
        await client.query("commit");
        return tasks;
      } catch (error) {
        await client.query("rollback").catch((rollbackError: unknown) => {
          // The connection is unusable: release it with the error so the pool discards it.
          broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
        });
        throw error;
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    },
    async execute(task) {
      const controller = new AbortController();
      const claim: Claim = {
        task,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
      };
      try {
        await claims.run(claim, () =>
          absurd.executeTask(task, claimTimeout, { fatalOnLeaseTimeout: false }),
        );
      } catch (error) {
        log("error", "executing a claimed task failed", {
          taskId: task.task_id,
          ...errorFields(error),
        });
      }
    },
  };
}

/**
 * Is `run` still the task's current attempt? Call inside the transaction that does the write it guards:
 * the check takes a share lock on the task row, so a second worker's claim (which updates that row) waits
 * for this transaction, and a write that passes is ordered before the new run's rehydration.
 * A false result means: stop, the task belongs to another run.
 */
export async function holdsRun(
  tx: TenantQueryable,
  run: Pick<RunContext, "taskId" | "runId" | "queue">,
): Promise<boolean> {
  if (!/^[a-z_]+$/.test(run.queue)) throw new Error(`unsafe queue name ${run.queue}`);
  const { rowCount } = await tx.query(
    `select 1 from absurd.t_${run.queue} where task_id = $1 and last_attempt_run = $2 and state = 'running' for share`,
    [run.taskId, run.runId],
  );
  return rowCount === 1;
}
