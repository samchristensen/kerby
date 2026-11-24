// Tenant database passwords (ADR 0009): random per tenant, stored sealed with the secret box under TENANT_DB_KEYS.
// Control writes them (provisioning, rotation, startup); api and worker read them to open tenant databases.
import { randomBytes } from "node:crypto";
import { type ControlDb, type ControlQueryable, isUuid } from "@kerby/db";
import type { SecretBox } from "@kerby/secrets";
import {
  TENANT_COLUMNS,
  type TenantRecord,
  type TenantRow,
  tenantDbUrl,
  tenantFromRow,
} from "./tenants.ts";

/** Authenticated data: a ciphertext moved to another tenant's row fails to open. */
const context = (tenantId: string) => `kerby-tenant-db:${tenantId}`;

/**
 * Open a tenant's sealed password from `tenant_db_credentials`. A ciphertext from another tenant's row, or sealed with
 * a key `box` does not hold, fails with the fix.
 */
function openTenantDbPassword(box: SecretBox, tenantId: string, sealed: Uint8Array): string {
  try {
    return box.open(sealed, context(tenantId));
  } catch (error) {
    throw new Error(
      `tenant ${tenantId}'s database password does not open with TENANT_DB_KEYS. Fix: put back the key it was sealed with; if that key is lost, delete the tenant's row from tenant_db_credentials and restart control, which gives the tenant a new password (ADR 0009)`,
      { cause: error },
    );
  }
}

/** A new tenant role password: 32 random bytes, base64url (safe in a URL and as a SQL literal). */
export const newTenantDbPassword = (): string => randomBytes(32).toString("base64url");

/**
 * Store `password` sealed for the tenant, replacing a stored one; with `ifAbsent`, keep a stored one and return false.
 * The row stays locked until the caller's transaction ends: run the matching `alter role` inside that transaction, so
 * the role and the row agree even when two writers race.
 */
export async function storeTenantDbPassword(
  db: ControlQueryable,
  box: SecretBox,
  tenantId: string,
  password: string,
  options: { ifAbsent?: boolean } = {},
): Promise<boolean> {
  const onConflict = options.ifAbsent
    ? "do nothing"
    : "do update set ciphertext = excluded.ciphertext, rotated_at = now()";
  const { rowCount } = await db.query(
    `insert into tenant_db_credentials (tenant_id, ciphertext) values ($1, $2) on conflict (tenant_id) ${onConflict}`,
    [tenantId, box.seal(password, context(tenantId))],
  );
  return rowCount === 1;
}

/** The tenant's stored password, opened; `undefined` when none is stored. */
export async function readTenantDbPassword(
  db: ControlQueryable,
  box: SecretBox,
  tenantId: string,
): Promise<string | undefined> {
  if (!isUuid(tenantId)) return undefined;
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    "select ciphertext from tenant_db_credentials where tenant_id = $1",
    [tenantId],
  );
  const sealed = rows[0]?.ciphertext;
  return sealed ? openTenantDbPassword(box, tenantId, sealed) : undefined;
}

/** The URL of the tenant's own database, as its own role with its stored password: what `TenantPools` resolves. */
export async function resolveTenantDbUrl(
  db: ControlQueryable,
  box: SecretBox,
  tenantId: string,
  sslmode?: "disable" | "require" | "verify-full",
): Promise<string> {
  if (!isUuid(tenantId)) throw new Error(`tenant ${tenantId} does not exist`);
  const { rows } = await db.query<TenantRow & { ciphertext: Buffer | null }>(
    `select ${TENANT_COLUMNS}, c.ciphertext
       from tenants t left join tenant_db_credentials c on c.tenant_id = t.id
      where t.id = $1`,
    [tenantId],
  );
  const row = rows[0];
  if (!row) throw new Error(`tenant ${tenantId} does not exist`);
  if (!row.ciphertext) {
    throw new Error(
      `tenant ${tenantId} has no stored database password. Fix: start the control service, which stores one for every tenant (ADR 0009)`,
    );
  }
  return tenantDbUrl(
    tenantFromRow(row),
    openTenantDbPassword(box, row.id, row.ciphertext),
    sslmode,
  );
}

/** Tenants not deleted and with no stored password: control gives each a new one at startup. */
export async function listTenantsWithoutDbPassword(db: ControlQueryable): Promise<TenantRecord[]> {
  const { rows } = await db.query<TenantRow>(
    `select ${TENANT_COLUMNS} from tenants t
      where status <> 'deleted' and not exists (select 1 from tenant_db_credentials c where c.tenant_id = t.id)
      order by created_at, id`,
  );
  return rows.map(tenantFromRow);
}

/**
 * Seal again with the first key every stored password sealed with an older one, so the older key can be dropped from
 * TENANT_DB_KEYS. A rotation that lands meanwhile wins. Returns how many were re-sealed.
 */
export async function resealTenantDbPasswords(db: ControlDb, box: SecretBox): Promise<number> {
  const { rows } = await db.query<{ tenant_id: string; ciphertext: Buffer }>(
    "select tenant_id, ciphertext from tenant_db_credentials",
  );
  let resealed = 0;
  for (const row of rows) {
    if (box.sealedWithCurrentKey(row.ciphertext)) continue;
    const password = openTenantDbPassword(box, row.tenant_id, row.ciphertext);
    const { rowCount } = await db.query(
      "update tenant_db_credentials set ciphertext = $3 where tenant_id = $1 and ciphertext = $2",
      [row.tenant_id, row.ciphertext, box.seal(password, context(row.tenant_id))],
    );
    resealed += rowCount;
  }
  return resealed;
}
