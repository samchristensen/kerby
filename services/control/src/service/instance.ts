// The install's one tenant (ADR 0024), kept equal to config at every start: the tenant itself, its configured API key,
// and its console admin. Every step is idempotent, so a restart, or two control processes starting together, change
// nothing that config did not change.
import {
  audit,
  deleteOtherConsoleUsers,
  EmailTakenError,
  ensureConfiguredApiKey,
  ensureDefaultIntegration,
  findConsoleUser,
  hashPassword,
  insertConsoleUser,
  listTenants,
  setConsoleUserPassword,
  setTenantStatus,
  type TenantRecord,
  verifyPassword,
} from "@kerby/control-plane";
import { log, withTenant } from "@kerby/observability";
import type { ControlDeps } from "../types/index.ts";
import { deleteTenant, provisionTenant } from "./tenants.ts";

export type InstanceSettings = {
  /** `KERBY_TENANT_NAME`: names the tenant when it is first made. */
  tenantName: string;
  /** `KERBY_API_KEY`: a key of the `default` integration, with every scope. */
  apiKey?: string | undefined;
  /** `KERBY_ADMIN_EMAIL` and `KERBY_ADMIN_PASSWORD`, the console's one account. */
  admin?: { email: string; password: string } | undefined;
  /** log2 of scrypt's N for the admin's password hash (`PASSWORD_COST`); tests use a cheap one. */
  passwordCost: number;
};

/** The install's tenant, made on the first start and repaired if a start died while making it. */
async function ensureTenant(deps: ControlDeps, name: string): Promise<TenantRecord> {
  const live = (await listTenants(deps.control)).filter((tenant) => tenant.status !== "deleted");
  if (live.length > 1) {
    throw new Error(
      `this install holds ${live.length} tenants, and a self-hosted Kerby serves one (ADR 0024). Fix: point it at a fresh Postgres, or delete the extra tenants (the operator API is at the git tag saas-poc)`,
    );
  }
  const existing = live[0];
  if (existing?.status === "active") return existing;
  if (existing?.status === "suspended") {
    return (await setTenantStatus(deps.control, existing.id, "active")) ?? existing;
  }
  if (existing) {
    // `provisioning` or `deleting`: a start that died halfway. Nothing usable is there; remove it and start over.
    withTenant(existing.id, () =>
      log("warn", "removing a tenant a previous start left unfinished", {
        status: existing.status,
      }),
    );
    await deleteTenant(deps, existing.id);
  }
  const { tenant } = await provisionTenant(deps, { name });
  withTenant(tenant.id, () => log("info", "tenant created", { name }));
  return tenant;
}

/** The configured admin is the tenant's only console account, with the configured password. */
async function ensureAdmin(
  deps: ControlDeps,
  tenant: TenantRecord,
  admin: { email: string; password: string },
  cost: number,
): Promise<void> {
  const { control } = deps;
  let user = await findConsoleUser(control, admin.email);
  if (user && user.tenantId !== tenant.id) {
    throw new Error(
      "KERBY_ADMIN_EMAIL belongs to an account of another tenant. Fix: point this install at a fresh Postgres",
    );
  }
  if (!user) {
    try {
      const passwordHash = await hashPassword(admin.password, cost);
      const { id } = await insertConsoleUser(control, {
        tenantId: tenant.id,
        email: admin.email,
        passwordHash,
      });
      user = { id, tenantId: tenant.id, email: admin.email, passwordHash };
      await audit(control, {
        tenantId: tenant.id,
        actor: "control",
        action: "console.admin.create",
      });
    } catch (error) {
      // Another control starting at the same moment made it: take theirs and check the password below.
      if (!(error instanceof EmailTakenError)) throw error;
      user = (await findConsoleUser(control, admin.email)) ?? undefined;
      if (!user) throw error;
    }
  } else if (!(await verifyPassword(admin.password, user.passwordHash))) {
    await setConsoleUserPassword(control, user.id, await hashPassword(admin.password, cost));
    await audit(control, {
      tenantId: tenant.id,
      actor: "control",
      action: "console.admin.password",
    });
  }
  const removed = await deleteOtherConsoleUsers(control, tenant.id, user.id);
  if (removed > 0) {
    await audit(control, {
      tenantId: tenant.id,
      actor: "control",
      action: "console.admin.replace",
      detail: { removed },
    });
  }
}

/** Make the install match config: its tenant, its API key, its admin. Returns the tenant. */
export async function bootstrapInstance(
  deps: ControlDeps,
  settings: InstanceSettings,
): Promise<TenantRecord> {
  const tenant = await ensureTenant(deps, settings.tenantName);
  return withTenant(tenant.id, async () => {
    if (settings.apiKey !== undefined) {
      const integration = await ensureDefaultIntegration(deps.control, tenant.id);
      const outcome = await ensureConfiguredApiKey(
        deps.control,
        tenant.id,
        integration.id,
        settings.apiKey,
      );
      if (outcome !== "kept") {
        await audit(deps.control, {
          tenantId: tenant.id,
          actor: "control",
          action: `api_key.configured.${outcome}`,
        });
      }
    }
    if (settings.admin) await ensureAdmin(deps, tenant, settings.admin, settings.passwordCost);
    log("info", "install ready", {
      configuredKey: settings.apiKey !== undefined,
      admin: settings.admin !== undefined,
    });
    return tenant;
  });
}
