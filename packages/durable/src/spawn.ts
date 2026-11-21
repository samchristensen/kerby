import type { TenantTx } from "@kerby/db";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY,
  TASKS,
  type TaskName,
  type TaskParams,
} from "./tasks.ts";

export type SpawnOptions = {
  /** A repeated spawn with the same key returns the existing task instead of creating another. */
  idempotencyKey: string;
  maxAttempts?: number;
  retry?: {
    kind: "fixed" | "exponential" | "none";
    baseSeconds?: number;
    factor?: number;
    maxSeconds?: number;
  };
};

export type Spawned = { taskId: string; runId: string; created: boolean };

/**
 * Enqueue a task on the caller's transaction, so the task exists if and only if the surrounding writes
 * commit (verified in plan 0001, S2). `tx` is a tenant transaction: the task lands in that tenant's database.
 */
export async function spawnInTx<N extends TaskName>(
  tx: TenantTx,
  name: N,
  params: TaskParams[N],
  options: SpawnOptions,
): Promise<Spawned> {
  const retry = options.retry ?? DEFAULT_RETRY;
  const absurdOptions = {
    idempotency_key: options.idempotencyKey,
    max_attempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    retry_strategy: {
      kind: retry.kind,
      ...(retry.baseSeconds === undefined ? {} : { base_seconds: retry.baseSeconds }),
      ...(retry.factor === undefined ? {} : { factor: retry.factor }),
      ...(retry.maxSeconds === undefined ? {} : { max_seconds: retry.maxSeconds }),
    },
  };
  const { rows } = await tx.query<{ task_id: string; run_id: string; created: boolean }>(
    "select task_id, run_id, created from absurd.spawn_task($1, $2, $3::jsonb, $4::jsonb)",
    [TASKS[name].queue, name, JSON.stringify(params), JSON.stringify(absurdOptions)],
  );
  const row = rows[0];
  if (!row) throw new Error(`spawn_task returned no row for ${name}`);
  return { taskId: row.task_id, runId: row.run_id, created: row.created };
}
