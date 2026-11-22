import { type Limits, LimitsSchema } from "@kerby/contracts";
import type { ControlQueryable } from "@kerby/db";
import { errorCode } from "@kerby/observability";

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleting" | "deleted";

export type TenantRecord = {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string;
  /** Parsed on every read: a row the schema does not accept fails loudly, never silently takes defaults. */
  limits: Limits;
  region: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbRole: string;
  schemaVersion: string | null;
  createdAt: Date;
};

export type TenantRow = {
  id: string;
  name: string;
  status: TenantStatus;
  plan: string;
  limits: Record<string, unknown>;
  region: string;
  db_host: string;
  db_port: number;
  db_name: string;
  db_role: string;
  schema_version: string | null;
  created_at: Date;
};

export const TENANT_COLUMNS =
  "id, name, status, plan, limits, region, db_host, db_port, db_name, db_role, schema_version, created_at";

export function tenantFromRow(row: TenantRow): TenantRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    plan: row.plan,
    limits: LimitsSchema.parse(row.limits),
    region: row.region,
    dbHost: row.db_host,
    dbPort: row.db_port,
    dbName: row.db_name,
    dbRole: row.db_role,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
  };
}

export class TenantNameTakenError extends Error {
  override name = "TenantNameTakenError";
}

/** Database and role names derive from the tenant id: nothing to look up, nothing a request can choose. */
function tenantDatabaseNames(tenantId: string): { dbName: string; dbRole: string } {
  const hex = tenantId.replaceAll("-", "");
  return { dbName: `t_${hex}`, dbRole: `r_${hex}` };
}

/** The connection URL for a tenant's own database, as its own role with `password` (see `resolveTenantDbUrl`). */
export function tenantDbUrl(
  tenant: Pick<TenantRecord, "dbHost" | "dbPort" | "dbName" | "dbRole">,
  password: string,
  sslmode?: "disable" | "require" | "verify-full",
): string {
  const url = new URL("postgres://placeholder");
  url.username = tenant.dbRole;
  url.password = password;
  url.hostname = tenant.dbHost;
  url.port = String(tenant.dbPort);
  url.pathname = `/${tenant.dbName}`;
  if (sslmode) url.searchParams.set("sslmode", sslmode);
  return url.toString();
}

export type NewTenant = {
  name: string;
  plan?: string;
  limits?: Limits;
  region?: string;
  dbHost: string;
  dbPort: number;
};

/** Insert a tenant in `provisioning` state. Throws `TenantNameTakenError` when the name exists. */
export async function insertTenant(db: ControlQueryable, tenant: NewTenant): Promise<TenantRecord> {
  const id = crypto.randomUUID();
  const { dbName, dbRole } = tenantDatabaseNames(id);
  try {
    const { rows } = await db.query<TenantRow>(
      `insert into tenants (id, name, plan, limits, region, db_host, db_port, db_name, db_role)
       values ($1, $2, coalesce($3, 'default'), $4::jsonb, coalesce($5, 'local'), $6, $7, $8, $9)
       returning ${TENANT_COLUMNS}`,
      [
        id,
        tenant.name,
        tenant.plan ?? null,
        JSON.stringify(tenant.limits ?? {}),
        tenant.region ?? null,
        tenant.dbHost,
        tenant.dbPort,
        dbName,
        dbRole,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("tenant insert returned no row");
    return tenantFromRow(row);
  } catch (error) {
    if (errorCode(error) === "23505")
      throw new TenantNameTakenError(`tenant name "${tenant.name}" is taken`);
    throw error;
  }
}

export async function getTenant(
  db: ControlQueryable,
  id: string,
): Promise<TenantRecord | undefined> {
  const { rows } = await db.query<TenantRow>(
    `select ${TENANT_COLUMNS} from tenants where id::text = $1`,
    [id],
  );
  return rows[0] ? tenantFromRow(rows[0]) : undefined;
}

export async function listTenants(
  db: ControlQueryable,
  filter: { status?: TenantStatus } = {},
): Promise<TenantRecord[]> {
  const { rows } = await db.query<TenantRow>(
    `select ${TENANT_COLUMNS} from tenants where ($1::text is null or status = $1) order by created_at, id`,
    [filter.status ?? null],
  );
  return rows.map(tenantFromRow);
}

export async function setTenantStatus(
  db: ControlQueryable,
  id: string,
  status: TenantStatus,
): Promise<TenantRecord | undefined> {
  const { rows } = await db.query<TenantRow>(
    `update tenants set status = $2, updated_at = now() where id::text = $1 returning ${TENANT_COLUMNS}`,
    [id, status],
  );
  return rows[0] ? tenantFromRow(rows[0]) : undefined;
}

export async function setSchemaVersion(
  db: ControlQueryable,
  id: string,
  version: string,
): Promise<void> {
  await db.query("update tenants set schema_version = $2, updated_at = now() where id::text = $1", [
    id,
    version,
  ]);
}

/** Remove a tenant row that never became usable (failed provisioning), with the password stored for it. */
export async function deleteTenantRow(db: ControlQueryable, id: string): Promise<void> {
  await db.query("delete from tenant_db_credentials where tenant_id::text = $1", [id]);
  await db.query("delete from tenants where id::text = $1", [id]);
}
