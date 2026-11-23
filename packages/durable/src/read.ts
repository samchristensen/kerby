import type { TenantQueryable } from "@kerby/db";
import { TASKS, type TaskName, type TaskParams, type TaskResults } from "./tasks.ts";

/** Absurd's task states. `sleeping` is a failed attempt waiting out its retry delay. */
type TaskState = "pending" | "running" | "sleeping" | "completed" | "failed" | "cancelled";

export type TaskRecord<N extends TaskName> = {
  id: string;
  state: TaskState;
  params: TaskParams[N];
  /** What the handler returned; null until the task completes. Written by Kerby's own handlers: validate before trusting. */
  result: TaskResults[N] | null;
  /** When the task was spawned. */
  createdAt: Date;
};

/**
 * One task of the given name, or undefined: an id that names a task of another kind is not found. Absurd's retention
 * deletes finished tasks after 30 days (`cleanup`), so a result is readable for that long.
 */
export async function readTask<N extends TaskName>(
  db: TenantQueryable,
  name: N,
  taskId: string,
): Promise<TaskRecord<N> | undefined> {
  const queue = TASKS[name].queue;
  const { rows } = await db.query<{
    state: TaskState;
    params: TaskParams[N];
    result: TaskResults[N] | null;
    created_at: Date;
  }>(
    `select t.state, t.params, t.completed_payload as result,
            (select min(r.created_at) from absurd.r_${queue} r where r.task_id = t.task_id) as created_at
       from absurd.t_${queue} t
      where t.task_id = $1 and t.task_name = $2`,
    [taskId, name],
  );
  const row = rows[0];
  return (
    row && {
      id: taskId,
      state: row.state,
      params: row.params,
      result: row.result,
      createdAt: row.created_at,
    }
  );
}
