// Integrations (ADR 0020): who a key acts for, and what it may do. The console makes and changes them; the api only
// reads them, through the key it authenticates.
import { DEFAULT_INTEGRATION, SCOPES, type Scope, ScopeSchema } from "@kerby/contracts";
import type { ControlDb, ControlQueryable } from "@kerby/db";
import { errorCode } from "@kerby/observability";

export type IntegrationRecord = {
  id: string;
  tenantId: string;
  name: string;
  scopes: Scope[];
  createdAt: Date;
};

type IntegrationRow = {
  id: string;
  tenant_id: string;
  name: string;
  scopes: string[];
  created_at: Date;
};

const INTEGRATION_COLUMNS = "id, tenant_id, name, scopes, created_at";

/** Scopes in catalog order; a scope the code no longer knows fails loudly rather than granting nothing quietly. */
const scopesFromRow = (scopes: readonly string[]): Scope[] => {
  const known = scopes.map((value) => ScopeSchema.parse(value));
  return SCOPES.filter((scope) => known.includes(scope));
};

export function integrationFromRow(row: IntegrationRow): IntegrationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    scopes: scopesFromRow(row.scopes),
    createdAt: row.created_at,
  };
}

export class IntegrationNameTakenError extends Error {
  override name = "IntegrationNameTakenError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Make an integration. Throws `IntegrationNameTakenError` when a live one of the tenant has the name. */
export async function createIntegration(
  db: ControlQueryable,
  tenantId: string,
  input: { name: string; scopes: readonly Scope[] },
): Promise<IntegrationRecord> {
  try {
    const { rows } = await db.query<IntegrationRow>(
      `insert into integrations (tenant_id, name, scopes) values ($1, $2, $3) returning ${INTEGRATION_COLUMNS}`,
      [tenantId, input.name, SCOPES.filter((scope) => input.scopes.includes(scope))],
    );
    const row = rows[0];
    if (!row) throw new Error("integration insert returned no row");
    return integrationFromRow(row);
  } catch (error) {
    if (errorCode(error) === "23505")
      throw new IntegrationNameTakenError(`an integration named "${input.name}" exists`);
    throw error;
  }
}

/** The tenant's `default` integration, made with every scope if it has none (provisioning, operators' keys). */
export async function ensureDefaultIntegration(
  db: ControlQueryable,
  tenantId: string,
): Promise<IntegrationRecord> {
  const found = await findIntegrationByName(db, tenantId, DEFAULT_INTEGRATION);
  if (found) return found;
  try {
    return await createIntegration(db, tenantId, { name: DEFAULT_INTEGRATION, scopes: SCOPES });
  } catch (error) {
    // Made by a concurrent call between the lookup and the insert.
    const raced =
      error instanceof IntegrationNameTakenError &&
      (await findIntegrationByName(db, tenantId, DEFAULT_INTEGRATION));
    if (raced) return raced;
    throw error;
  }
}

async function findIntegrationByName(
  db: ControlQueryable,
  tenantId: string,
  name: string,
): Promise<IntegrationRecord | undefined> {
  const { rows } = await db.query<IntegrationRow>(
    `select ${INTEGRATION_COLUMNS} from integrations
      where tenant_id::text = $1 and name = $2 and deleted_at is null`,
    [tenantId, name],
  );
  return rows[0] ? integrationFromRow(rows[0]) : undefined;
}

/** The tenant's live integrations, oldest first. */
export async function listIntegrations(
  db: ControlQueryable,
  tenantId: string,
): Promise<IntegrationRecord[]> {
  const { rows } = await db.query<IntegrationRow>(
    `select ${INTEGRATION_COLUMNS} from integrations
      where tenant_id::text = $1 and deleted_at is null order by created_at, id`,
    [tenantId],
  );
  return rows.map(integrationFromRow);
}

/** A live integration of this tenant, or undefined (another tenant's id is simply not found). */
export async function getIntegration(
  db: ControlQueryable,
  tenantId: string,
  integrationId: string,
): Promise<IntegrationRecord | undefined> {
  if (!UUID.test(integrationId)) return undefined;
  const { rows } = await db.query<IntegrationRow>(
    `select ${INTEGRATION_COLUMNS} from integrations
      where id = $1 and tenant_id::text = $2 and deleted_at is null`,
    [integrationId, tenantId],
  );
  return rows[0] ? integrationFromRow(rows[0]) : undefined;
}

/** Replace a live integration's scopes; undefined when there is no such integration. Keys follow within the auth TTL. */
export async function setIntegrationScopes(
  db: ControlQueryable,
  tenantId: string,
  integrationId: string,
  scopes: readonly Scope[],
): Promise<IntegrationRecord | undefined> {
  if (!UUID.test(integrationId)) return undefined;
  const { rows } = await db.query<IntegrationRow>(
    `update integrations set scopes = $3
      where id = $1 and tenant_id::text = $2 and deleted_at is null
      returning ${INTEGRATION_COLUMNS}`,
    [integrationId, tenantId, SCOPES.filter((scope) => scopes.includes(scope))],
  );
  return rows[0] ? integrationFromRow(rows[0]) : undefined;
}

/**
 * Delete an integration: revoke its keys and delete its subscriptions, in one transaction. The row stays, marked, as
 * revoked keys do. False when there is no such live integration.
 */
export async function deleteIntegration(
  db: ControlDb,
  tenantId: string,
  integrationId: string,
): Promise<boolean> {
  if (!UUID.test(integrationId)) return false;
  return db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `update integrations set deleted_at = now()
        where id = $1 and tenant_id::text = $2 and deleted_at is null`,
      [integrationId, tenantId],
    );
    if (rowCount !== 1) return false;
    await tx.query(
      "update api_keys set revoked_at = now() where integration_id = $1 and revoked_at is null",
      [integrationId],
    );
    // Tombstones: the dispatcher cancels their queued deliveries in the tenant's database, then removes them.
    await tx.query(
      `update subscriptions set state = 'deleted', updated_at = now()
        where integration_id = $1 and tenant_id::text = $2 and state <> 'deleted'`,
      [integrationId, tenantId],
    );
    return true;
  });
}
