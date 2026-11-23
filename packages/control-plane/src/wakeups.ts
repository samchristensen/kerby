// When each tenant's queue next needs a worker to look (`tenant_wakeups`, migration 0008; ADR 0004). The api hints
// after it enqueues; a worker reads the hint's version, claims, then settles the next due time unless another hint
// arrived meanwhile. Workers sweep only tenants that are due; a slow full sweep is the backstop.
import { type ControlQueryable, isUuid } from "@kerby/db";
import { TENANT_COLUMNS, type TenantRecord, type TenantRow, tenantFromRow } from "./tenants.ts";

/**
 * Mark the tenant's queue due now, then ring the doorbell (`NOTIFY tenant_work`). Call after the transaction that
 * enqueued the work commits, so a worker that sees the hint can claim it.
 *
 * Two autocommit statements, never one transaction: a commit that both writes and sends a NOTIFY holds a
 * cluster-wide lock through its WAL flush, so such commits serialize across every database (measured on Postgres
 * 18, 32 clients: 9.2k against 20k writes/s); a NOTIFY alone has nothing to flush. The upsert goes first, so a
 * worker woken by the NOTIFY reads the bumped version; if the NOTIFY then fails, the due sweep still finds the hint.
 */
export async function hintTenantWork(db: ControlQueryable, tenantId: string): Promise<void> {
  if (!isUuid(tenantId)) return;
  await db.query(
    `insert into tenant_wakeups (tenant_id, due_at, version) values ($1, now(), 1)
     on conflict (tenant_id) do update set due_at = now(), version = tenant_wakeups.version + 1`,
    [tenantId],
  );
  await db.query("select pg_notify('tenant_work', $1)", [tenantId]);
}

/** The tenant's hint version, read before a claim and passed to `settleTenantWakeup` after it. "0": no hint yet. */
export async function readWakeupVersion(db: ControlQueryable, tenantId: string): Promise<string> {
  if (!isUuid(tenantId)) return "0";
  const { rows } = await db.query<{ version: string }>(
    "select version::text as version from tenant_wakeups where tenant_id = $1",
    [tenantId],
  );
  return rows[0]?.version ?? "0";
}

/**
 * Record when the tenant's queue next needs a look (null: nothing waits), unless a hint arrived since `version` was
 * read: that hint wins and the tenant stays due. Returns whether the due time was written.
 */
export async function settleTenantWakeup(
  db: ControlQueryable,
  tenantId: string,
  version: string,
  dueAt: Date | null,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    `insert into tenant_wakeups (tenant_id, due_at, version) values ($1, $2, $3::bigint)
     on conflict (tenant_id) do update set due_at = excluded.due_at
       where tenant_wakeups.version = excluded.version`,
    [tenantId, dueAt, version],
  );
  return (rowCount ?? 0) > 0;
}

/** Active tenants whose queue is due now, longest due first. */
export async function listDueTenants(db: ControlQueryable): Promise<TenantRecord[]> {
  const { rows } = await db.query<TenantRow>(
    `select ${TENANT_COLUMNS} from tenant_wakeups join tenants on tenants.id = tenant_wakeups.tenant_id
      where tenant_wakeups.due_at <= now() and tenants.status = 'active'
      order by tenant_wakeups.due_at`,
  );
  return rows.map(tenantFromRow);
}
