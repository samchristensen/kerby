import type { TenantDb } from "@kerby/db";

/**
 * Delete completed, failed and cancelled tasks older than each queue's `cleanup_ttl` (Absurd's default is 30
 * days; it runs only when called, so each tenant needs this on a daily schedule). Returns the tasks deleted.
 * Source of truth for a conversation is the tenant's message index, never Absurd's rows.
 */
export async function cleanup(db: TenantDb): Promise<number> {
  let total = 0;
  // Each call deletes one bounded batch per queue: repeat until a call deletes nothing.
  for (let round = 0; round < 1000; round++) {
    const { rows } = await db.query<{ tasks_deleted: number }>(
      "select tasks_deleted from absurd.cleanup_all_queues()",
    );
    const deleted = rows.reduce((sum, row) => sum + row.tasks_deleted, 0);
    if (deleted === 0) break;
    total += deleted;
  }
  return total;
}
