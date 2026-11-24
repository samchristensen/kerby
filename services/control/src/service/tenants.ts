import { tenantPrefix } from "@kerby/blobs";
import {
  audit,
  deleteTenantRow,
  ensureDefaultIntegration,
  getTenant,
  insertTenant,
  newTenantDbPassword,
  setSchemaVersion,
  setTenantStatus,
  storeTenantDbPassword,
  type TenantRecord,
} from "@kerby/control-plane";
import { tenantMigrationDirs } from "@kerby/conversations";
import { migrate, readMigrations } from "@kerby/db";
import { alert, errorFields, withTenant } from "@kerby/observability";
import type { ControlDeps } from "../types/index.ts";

const ACTOR = "control";

/** The newest tenant migration, recorded as a tenant's `schema_version`. */
export function currentSchemaVersion(): string {
  const last = readMigrations(tenantMigrationDirs).at(-1);
  if (!last) throw new Error("there are no tenant migrations");
  return last.name;
}

/**
 * Provision a tenant: a database copied from the template, a role that can reach only it, the tenant migrations, and
 * the `default` integration. On any failure nothing is left behind: the database, the role and the row are removed.
 */
export async function provisionTenant(
  deps: ControlDeps,
  request: { name: string },
): Promise<{ tenant: TenantRecord }> {
  const { control, cluster, settings, pools, tenantDbBox } = deps;
  const tenant = await insertTenant(control, {
    name: request.name,
    dbHost: settings.clusterHost,
    dbPort: settings.clusterPort,
  });

  try {
    // Stored before the role exists, so control's startup repair never gives a role being made a second password.
    const password = newTenantDbPassword();
    await storeTenantDbPassword(control, tenantDbBox, tenant.id, password);
    await cluster.createRole(tenant.dbRole, password);
    await cluster.createDatabase(tenant.dbName, {
      template: settings.templateDatabase,
      owner: tenant.dbRole,
    });
    await cluster.reassignOwned(tenant.dbName, tenant.dbRole);
    await cluster.restrictDatabase(tenant.dbName, tenant.dbRole);
    // The copy may predate the newest migrations: catch up, as the tenant's own role.
    await pools.use(tenant.id, (db) => migrate(db, tenantMigrationDirs));
    await setSchemaVersion(control, tenant.id, currentSchemaVersion());
    await ensureDefaultIntegration(control, tenant.id);
    const active = await setTenantStatus(control, tenant.id, "active");
    await audit(control, {
      tenantId: tenant.id,
      actor: ACTOR,
      action: "tenant.create",
      detail: { name: tenant.name },
    });
    return { tenant: active ?? tenant };
  } catch (error) {
    withTenant(tenant.id, () => alert("provisioning failed", errorFields(error)));
    await pools.evict(tenant.id);
    await cluster.dropDatabase(tenant.dbName).catch(() => {});
    await cluster.dropRole(tenant.dbRole).catch(() => {});
    await deleteTenantRow(control, tenant.id).catch(() => {});
    throw error;
  }
}

/**
 * Delete: drop the database and role, delete the object prefix, purge subscriptions, keys, integrations, secrets, the
 * console's people and sessions, and the workers' wake-up hint. Every step is safe to repeat. The row stays, status
 * `deleted`. Control uses it to clear a tenant a start left unfinished.
 */
export async function deleteTenant(deps: ControlDeps, id: string): Promise<void> {
  const { control, cluster, bucket, pools } = deps;
  const tenant = await getTenant(control, id);
  if (!tenant || tenant.status === "deleted") return;
  await setTenantStatus(control, id, "deleting");
  await pools.evict(id);
  await cluster.dropDatabase(tenant.dbName);
  await cluster.dropRole(tenant.dbRole);
  const objects = await bucket.deletePrefix(tenantPrefix(id));
  await control.transaction(async (tx) => {
    // Foreign-key order: subscriptions and keys reference integrations.
    await tx.query("delete from subscriptions where tenant_id = $1", [tenant.id]);
    await tx.query("delete from api_keys where tenant_id = $1", [tenant.id]);
    await tx.query("delete from integrations where tenant_id = $1", [tenant.id]);
    await tx.query("delete from tenant_secrets where tenant_id = $1", [tenant.id]);
    await tx.query("delete from tenant_db_credentials where tenant_id = $1", [tenant.id]);
    await tx.query("delete from console_sessions where tenant_id = $1", [tenant.id]);
    await tx.query("delete from console_users where tenant_id = $1", [tenant.id]);
    await tx.query("delete from tenant_wakeups where tenant_id = $1", [tenant.id]);
    await setTenantStatus(tx, id, "deleted");
  });
  await audit(control, {
    tenantId: id,
    actor: ACTOR,
    action: "tenant.delete",
    detail: { objectsDeleted: objects },
  });
}
