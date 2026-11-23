import { tenantPrefix } from "@kerby/blobs";
import type { Limits } from "@kerby/contracts";
import {
  audit,
  createApiKey,
  deleteTenantRow,
  ensureDefaultIntegration,
  getTenant,
  insertTenant,
  listTenants,
  newTenantDbPassword,
  setSchemaVersion,
  setTenantStatus,
  storeTenantDbPassword,
  TenantNameTakenError,
  type TenantRecord,
} from "@kerby/control-plane";
import { tenantMigrationDirs } from "@kerby/conversations";
import { migrate, readMigrations } from "@kerby/db";
import { alert, errorFields, withTenant } from "@kerby/observability";
import { ConflictError, type ControlDeps, NotFoundError } from "../types/index.ts";

const ACTOR = "operator";

/** The newest tenant migration, recorded as a tenant's `schema_version`. */
export function currentSchemaVersion(): string {
  const last = readMigrations(tenantMigrationDirs).at(-1);
  if (!last) throw new Error("there are no tenant migrations");
  return last.name;
}

export type ProvisionRequest = {
  name: string;
  plan?: string | undefined;
  limits?: Limits | undefined;
};
export type Provisioned = { tenant: TenantRecord; key: Awaited<ReturnType<typeof createApiKey>> };

/**
 * Provision a tenant: a database copied from the template, a role that can reach only it, the tenant migrations,
 * the first key. On any failure nothing is left behind: the database, the role and the row are removed. `actor` is who
 * asked, for the audit log: an operator, or the console at sign-up.
 */
export async function provisionTenant(
  deps: ControlDeps,
  request: ProvisionRequest,
  actor: "operator" | "console" = ACTOR,
): Promise<Provisioned> {
  const { control, cluster, settings, pools, tenantDbBox } = deps;
  let tenant: TenantRecord;
  try {
    tenant = await insertTenant(control, {
      name: request.name,
      ...(request.plan === undefined ? {} : { plan: request.plan }),
      ...(request.limits === undefined ? {} : { limits: request.limits }),
      dbHost: settings.clusterHost,
      dbPort: settings.clusterPort,
    });
  } catch (error) {
    if (error instanceof TenantNameTakenError) throw new ConflictError(error.message, "name_taken");
    throw error;
  }

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
    const integration = await ensureDefaultIntegration(control, tenant.id);
    const key = await createApiKey(control, tenant.id, integration.id, "initial");
    const active = await setTenantStatus(control, tenant.id, "active");
    await audit(control, {
      tenantId: tenant.id,
      actor,
      action: "tenant.create",
      detail: { name: tenant.name },
    });
    return { tenant: active ?? tenant, key };
  } catch (error) {
    withTenant(tenant.id, () => alert("provisioning failed", errorFields(error)));
    await pools.evict(tenant.id);
    await cluster.dropDatabase(tenant.dbName).catch(() => {});
    await cluster.dropRole(tenant.dbRole).catch(() => {});
    await deleteTenantRow(control, tenant.id).catch(() => {});
    throw error;
  }
}

async function requireTenant(deps: ControlDeps, id: string): Promise<TenantRecord> {
  const tenant = await getTenant(deps.control, id);
  if (!tenant || tenant.status === "deleted") throw new NotFoundError(`tenant ${id} not found`);
  return tenant;
}

export async function getTenantRecord(deps: ControlDeps, id: string): Promise<TenantRecord> {
  return requireTenant(deps, id);
}

export async function listTenantRecords(deps: ControlDeps): Promise<TenantRecord[]> {
  return (await listTenants(deps.control)).filter((tenant) => tenant.status !== "deleted");
}

/** Suspend: the API refuses the tenant's keys within its auth cache TTL. Its data stays. */
export async function suspendTenant(deps: ControlDeps, id: string): Promise<TenantRecord> {
  const tenant = await requireTenant(deps, id);
  if (tenant.status !== "active" && tenant.status !== "suspended") {
    throw new ConflictError(`tenant is ${tenant.status}, not active`);
  }
  const updated = await setTenantStatus(deps.control, id, "suspended");
  await audit(deps.control, { tenantId: id, actor: ACTOR, action: "tenant.suspend" });
  return updated ?? tenant;
}

export async function resumeTenant(deps: ControlDeps, id: string): Promise<TenantRecord> {
  const tenant = await requireTenant(deps, id);
  if (tenant.status !== "active" && tenant.status !== "suspended") {
    throw new ConflictError(`tenant is ${tenant.status}, not suspended`);
  }
  const updated = await setTenantStatus(deps.control, id, "active");
  await audit(deps.control, { tenantId: id, actor: ACTOR, action: "tenant.resume" });
  return updated ?? tenant;
}

/**
 * Delete: refuse new work, drop the database and role, delete the object prefix, purge subscriptions, keys,
 * integrations, secrets and the console's
 * people and sessions. Every step is safe to repeat, so a failed delete is retried by calling it again. The row stays,
 * status `deleted`.
 */
export async function deleteTenant(deps: ControlDeps, id: string): Promise<void> {
  const { control, cluster, buckets, pools } = deps;
  const tenant = await getTenant(control, id);
  if (!tenant || tenant.status === "deleted") throw new NotFoundError(`tenant ${id} not found`);
  await setTenantStatus(control, id, "deleting");
  await pools.evict(id);
  await cluster.dropDatabase(tenant.dbName);
  await cluster.dropRole(tenant.dbRole);
  const objects = await buckets.primary.deletePrefix(tenantPrefix(id));
  await control.transaction(async (tx) => {
    // Foreign-key order: subscriptions and keys reference integrations.
    await tx.query("delete from subscriptions where tenant_id::text = $1", [id]);
    await tx.query("delete from api_keys where tenant_id::text = $1", [id]);
    await tx.query("delete from integrations where tenant_id::text = $1", [id]);
    await tx.query("delete from tenant_secrets where tenant_id::text = $1", [id]);
    await tx.query("delete from tenant_db_credentials where tenant_id::text = $1", [id]);
    await tx.query("delete from console_sessions where tenant_id::text = $1", [id]);
    await tx.query("delete from console_users where tenant_id::text = $1", [id]);
    await setTenantStatus(tx, id, "deleted");
  });
  await audit(control, {
    tenantId: id,
    actor: ACTOR,
    action: "tenant.delete",
    detail: { objectsDeleted: objects },
  });
}
