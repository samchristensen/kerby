import {
  audit,
  listTenantsWithoutDbPassword,
  newTenantDbPassword,
  resealTenantDbPasswords,
  storeTenantDbPassword,
  type TenantRecord,
} from "@kerby/control-plane";
import { log } from "@kerby/observability";
import { ConflictError, type ControlDeps } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

/**
 * Give the tenant's role a new random password: store it and `alter role` in one control transaction, which holds the
 * row's lock, so concurrent writers leave the role and the row agreeing and a failed `alter role` stores nothing
 * (ADR 0009). With `ifAbsent`, a password stored meanwhile by another process wins. Returns whether it changed.
 */
async function setTenantDbPassword(
  deps: ControlDeps,
  tenant: TenantRecord,
  options: { ifAbsent?: boolean } = {},
): Promise<boolean> {
  const password = newTenantDbPassword();
  return deps.control.transaction(async (tx) => {
    if (!(await storeTenantDbPassword(tx, deps.tenantDbBox, tenant.id, password, options))) {
      return false;
    }
    await deps.cluster.setRolePassword(tenant.dbRole, password);
    return true;
  });
}

/**
 * Rotate a tenant's database password. Open sessions keep working; every pool logs in with the new password at its
 * next connection, after Postgres refuses the old one.
 */
export async function rotateTenantDbPassword(deps: ControlDeps, id: string): Promise<TenantRecord> {
  const tenant = await getTenantRecord(deps, id);
  if (tenant.status !== "active" && tenant.status !== "suspended") {
    throw new ConflictError(`tenant is ${tenant.status}, not active or suspended`);
  }
  await setTenantDbPassword(deps, tenant);
  await audit(deps.control, {
    tenantId: id,
    actor: "operator",
    action: "tenant.rotate_db_password",
  });
  return tenant;
}

/**
 * At startup: a new password for every tenant whose role has none stored (tenants made before ADR 0009, or rows deleted
 * after losing TENANT_DB_KEYS), and every stored one sealed with an older key sealed again with the first. Idempotent,
 * and safe with several control replicas starting at once.
 */
export async function ensureTenantDbPasswords(
  deps: ControlDeps,
): Promise<{ created: number; resealed: number }> {
  let created = 0;
  for (const tenant of await listTenantsWithoutDbPassword(deps.control)) {
    // Provisioning stores the password before it makes the role, and deletion drops the role: no role, nothing to set.
    if (!(await deps.cluster.roleExists(tenant.dbRole))) continue;
    if (await setTenantDbPassword(deps, tenant, { ifAbsent: true })) {
      created++;
      await audit(deps.control, {
        tenantId: tenant.id,
        actor: "control",
        action: "tenant.rotate_db_password",
        detail: { reason: "none stored" },
      });
    }
  }
  const resealed = await resealTenantDbPasswords(deps.control, deps.tenantDbBox);
  log("info", "tenant database passwords checked", { created, resealed });
  return { created, resealed };
}
