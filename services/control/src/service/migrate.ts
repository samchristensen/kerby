import { audit, listTenants, setSchemaVersion } from "@kerby/control-plane";
import { tenantMigrationDirs } from "@kerby/conversations";
import { migrateTenants } from "@kerby/db";
import { alert, errorFields, log, withTenant } from "@kerby/observability";
import type { ControlDeps } from "../types/index.ts";
import { ensureTemplate } from "./template.ts";
import { currentSchemaVersion } from "./tenants.ts";

export type MigrationRun = { migrated: number; failed: { tenantId: string; error: string }[] };

/**
 * Bring the template and every active or suspended tenant database to the current tenant migrations, recording
 * `schema_version` per tenant. Failures are reported per tenant and do not stop the others (ADR 0004: code tolerates
 * versions n and n-1, so a partial rollout is safe).
 */
export async function migrateAllTenants(deps: ControlDeps): Promise<MigrationRun> {
  await ensureTemplate(deps);
  const tenants = (await listTenants(deps.control)).filter(
    (t) => t.status === "active" || t.status === "suspended",
  );
  // Roles made before connection limits existed get theirs now (idempotent).
  for (const tenant of tenants) await deps.cluster.limitRoleConnections(tenant.dbRole);
  // A tenant role may not create pgvector's `vector` (not a trusted extension, ADR 0021): install it as the admin
  // first. A database that cannot take it is reported with the failed migrations and not migrated.
  const ready: string[] = [];
  const unprepared: { tenantId: string; error: Error }[] = [];
  for (const tenant of tenants) {
    try {
      await deps.cluster.ensureExtension(tenant.dbName, "vector");
      ready.push(tenant.id);
    } catch (error) {
      unprepared.push({
        tenantId: tenant.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  const fanOut = await migrateTenants(deps.pools, ready, tenantMigrationDirs);
  const result = { migrated: fanOut.migrated, failed: [...unprepared, ...fanOut.failed] };
  const version = currentSchemaVersion();
  for (const tenantId of result.migrated) await setSchemaVersion(deps.control, tenantId, version);
  await audit(deps.control, {
    tenantId: null,
    actor: "operator",
    action: "tenants.migrate",
    detail: { migrated: result.migrated.length, failed: result.failed.length },
  });
  for (const { tenantId, error } of result.failed) {
    withTenant(tenantId, () => log("error", "tenant migration failed", errorFields(error)));
  }
  if (result.failed.length > 0) {
    // One alert per run: the per-tenant lines above say which tenants and why (`make logs-query MSG=...`).
    alert("migration fan-out failed", {
      failed: result.failed.length,
      migrated: result.migrated.length,
      firstFailedTenant: result.failed[0]?.tenantId,
    });
  }
  return {
    migrated: result.migrated.length,
    failed: result.failed.map((f) => ({ tenantId: f.tenantId, error: f.error.message })),
  };
}
