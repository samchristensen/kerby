import type { ControlQueryable } from "@kerby/db";

/** Identifiers and counts only: never message content or secrets (principle 8). */
export type AuditDetail = Record<string, string | number | boolean | null>;

export async function audit(
  db: ControlQueryable,
  entry: { tenantId: string | null; actor: string; action: string; detail?: AuditDetail },
): Promise<void> {
  await db.query(
    "insert into audit_log (tenant_id, actor, action, detail) values ($1, $2, $3, $4::jsonb)",
    [entry.tenantId, entry.actor, entry.action, JSON.stringify(entry.detail ?? {})],
  );
}
