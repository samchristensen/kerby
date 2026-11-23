import type { TenantTx } from "@kerby/db";
import { TASKS, type TaskName, type TaskParams } from "./tasks.ts";

/**
 * Cancel the queued tasks of `name` whose param `key` is `value` (say, every delivery of a deleted subscription), on the
 * caller's transaction. Pending and sleeping tasks never run again; a running one finishes its attempt and is not
 * retried. Returns how many were cancelled.
 */
export async function cancelTasks<N extends TaskName>(
  tx: TenantTx,
  name: N,
  key: keyof TaskParams[N] & string,
  value: string,
): Promise<number> {
  const queue = TASKS[name].queue;
  const { rows } = await tx.query<{ cancelled: number }>(
    `with cancelled as (
       select t.task_id, absurd.cancel_task($1, t.task_id)
         from absurd.t_${queue} t
        where t.task_name = $2 and t.params->>$3 = $4 and t.state in ('pending', 'sleeping', 'running')
     )
     select count(*)::int as cancelled from cancelled`,
    [queue, name, key, value],
  );
  return rows[0]?.cancelled ?? 0;
}
