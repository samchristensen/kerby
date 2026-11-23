// Integrations (ADR 0019): a tenant's named clients. Every API key belongs to one, and the key may do what its
// integration's role allows. Archiving an integration revokes its keys; the row stays (audit, grants by id) and frees
// its name.
import type { IntegrationRole } from "@kerby/contracts";
import type { ControlDb, ControlQueryable } from "@kerby/db";
import { errorCode } from "@kerby/observability";

export type IntegrationRecord = {
  id: string;
  tenantId: string;
  name: string;
  role: IntegrationRole;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

type IntegrationRow = {
  id: string;
  tenant_id: string;
  name: string;
  role: IntegrationRole;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

const COLUMNS = "id, tenant_id, name, role, created_at, updated_at, archived_at";

function integrationFromRow(row: IntegrationRow): IntegrationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export class IntegrationNameTakenError extends Error {
  override name = "IntegrationNameTakenError";
}

/** A key was asked for in an integration that is not a live integration of its tenant. */
export class IntegrationNotFoundError extends Error {
  override name = "IntegrationNotFoundError";
}

function nameTaken(error: unknown, name: string): never {
  if (errorCode(error) === "23505")
    throw new IntegrationNameTakenError(
      `an integration named "${name}" already exists. Fix: choose another name, or archive the existing one first`,
    );
  throw error;
}

/** Throws `IntegrationNameTakenError` when a live integration of the tenant has the name. */
export async function createIntegration(
  db: ControlQueryable,
  input: { tenantId: string; name: string; role: IntegrationRole },
): Promise<IntegrationRecord> {
  try {
    const { rows } = await db.query<IntegrationRow>(
      `insert into integrations (tenant_id, name, role) values ($1, $2, $3) returning ${COLUMNS}`,
      [input.tenantId, input.name, input.role],
    );
    const row = rows[0];
    if (!row) throw new Error("integration insert returned no row");
    return integrationFromRow(row);
  } catch (error) {
    return nameTaken(error, input.name);
  }
}

/** The tenant's live integrations, by name. */
export async function listIntegrations(
  db: ControlQueryable,
  tenantId: string,
): Promise<IntegrationRecord[]> {
  const { rows } = await db.query<IntegrationRow>(
    `select ${COLUMNS} from integrations where tenant_id::text = $1 and archived_at is null order by name, id`,
    [tenantId],
  );
  return rows.map(integrationFromRow);
}

/** A live integration of this tenant; undefined for anything else, including an id that is not a uuid. */
export async function getIntegration(
  db: ControlQueryable,
  tenantId: string,
  id: string,
): Promise<IntegrationRecord | undefined> {
  const { rows } = await db.query<IntegrationRow>(
    `select ${COLUMNS} from integrations where id::text = $1 and tenant_id::text = $2 and archived_at is null`,
    [id, tenantId],
  );
  const row = rows[0];
  return row && integrationFromRow(row);
}

export async function findIntegrationByName(
  db: ControlQueryable,
  tenantId: string,
  name: string,
): Promise<IntegrationRecord | undefined> {
  const { rows } = await db.query<IntegrationRow>(
    `select ${COLUMNS} from integrations where tenant_id::text = $1 and name = $2 and archived_at is null`,
    [tenantId, name],
  );
  const row = rows[0];
  return row && integrationFromRow(row);
}

/** Rename or change the role of a live integration. Undefined when there is none; `IntegrationNameTakenError`. */
export async function updateIntegration(
  db: ControlQueryable,
  tenantId: string,
  id: string,
  changes: { name?: string; role?: IntegrationRole },
): Promise<IntegrationRecord | undefined> {
  try {
    const { rows } = await db.query<IntegrationRow>(
      `update integrations set name = coalesce($3, name), role = coalesce($4, role), updated_at = now()
        where id::text = $1 and tenant_id::text = $2 and archived_at is null returning ${COLUMNS}`,
      [id, tenantId, changes.name ?? null, changes.role ?? null],
    );
    const row = rows[0];
    return row && integrationFromRow(row);
  } catch (error) {
    return nameTaken(error, changes.name ?? "");
  }
}

/** Archive a live integration and revoke its live keys, together. False when there is no such integration. */
export async function archiveIntegration(
  db: ControlDb,
  tenantId: string,
  id: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `update integrations set archived_at = now(), updated_at = now()
        where id::text = $1 and tenant_id::text = $2 and archived_at is null returning id`,
      [id, tenantId],
    );
    const archived = rows[0];
    if (!archived) return false;
    await tx.query(
      "update api_keys set revoked_at = now() where integration_id = $1 and revoked_at is null",
      [archived.id],
    );
    return true;
  });
}
