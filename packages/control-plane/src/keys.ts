// API keys look like `kb_<id>_<secret>`. The id is public and indexes the row; only a hash of the secret is
// stored. The secret is 256 random bits, so a plain SHA-256 is enough: there is nothing to brute-force.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type ControlQueryable, isUuid } from "@kerby/db";
import { type IntegrationRecord, integrationFromRow } from "./integrations.ts";
import { TENANT_COLUMNS, type TenantRecord, type TenantRow, tenantFromRow } from "./tenants.ts";

export type ApiKeyRecord = {
  id: string;
  tenantId: string;
  /** The integration the key acts for (ADR 0020). */
  integrationId: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

type KeyRow = {
  id: string;
  tenant_id: string;
  integration_id: string;
  label: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const KEY_COLUMNS = "id, tenant_id, integration_id, label, created_at, last_used_at, revoked_at";

function keyFromRow(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    integrationId: row.integration_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

const hash = (secret: string) => createHash("sha256").update(secret).digest();

/** `kb_<12 hex>_<43 base64url>` -> its parts; undefined for anything else. */
export function parseApiKey(key: string): { id: string; secret: string } | undefined {
  const match = /^kb_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(key);
  return match?.[1] && match[2] ? { id: match[1], secret: match[2] } : undefined;
}

export type CreatedKey = { key: ApiKeyRecord; secret: string };

/**
 * Live (unrevoked) keys a tenant may hold: one per service, environment and CI job with room to spare. Every key is a
 * row and a credential the api may cache, so a tenant (any signed-in console person) must not mint them without end.
 */
export const MAX_API_KEYS_PER_TENANT = 50;

export class ApiKeyLimitError extends Error {
  override name = "ApiKeyLimitError";
}

/**
 * Create a key for one of the tenant's live integrations (ADR 0020). The returned `secret` is the whole key, shown once
 * and never stored. Throws when the integration is not the tenant's or was deleted, and `ApiKeyLimitError` when the
 * tenant already holds `MAX_API_KEYS_PER_TENANT` live keys; inside a transaction that revoked one first (rotation), that
 * one no longer counts.
 */
export async function createApiKey(
  db: ControlQueryable,
  tenantId: string,
  integrationId: string,
  label = "",
): Promise<CreatedKey> {
  if ("transaction" in db)
    return db.transaction((tx) => createApiKey(tx, tenantId, integrationId, label));
  if (!isUuid(tenantId) || !isUuid(integrationId))
    throw new Error(`integration ${integrationId} is not a live integration of the tenant`);
  // Key creation is serialized per tenant until the transaction ends, so concurrent creates cannot all count the
  // same keys and pass the cap together.
  await db.query("select pg_advisory_xact_lock(hashtext('kerby.api_keys'), hashtext($1))", [
    tenantId,
  ]);
  const live = await db.query(
    "select 1 from integrations where id = $1 and tenant_id = $2 and deleted_at is null",
    [integrationId, tenantId],
  );
  if (live.rowCount !== 1)
    throw new Error(`integration ${integrationId} is not a live integration of the tenant`);
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const { rows } = await db.query<KeyRow>(
    `insert into api_keys (id, tenant_id, integration_id, label, key_hash)
     select $1, $2::uuid, $3::uuid, $4, $5
      where (select count(*) from api_keys where tenant_id = $2::uuid and revoked_at is null) < $6
     returning ${KEY_COLUMNS}`,
    [id, tenantId, integrationId, label, hash(secret), MAX_API_KEYS_PER_TENANT],
  );
  const row = rows[0];
  if (!row) {
    throw new ApiKeyLimitError(
      `a tenant may hold at most ${MAX_API_KEYS_PER_TENANT} live API keys: revoke one it no longer uses, then create the new one`,
    );
  }
  return { key: keyFromRow(row), secret: `kb_${id}_${secret}` };
}

/** The tenant's keys, or one integration's, oldest first; revoked ones included. */
export async function listApiKeys(
  db: ControlQueryable,
  tenantId: string,
  integrationId?: string,
): Promise<ApiKeyRecord[]> {
  if (!isUuid(tenantId) || (integrationId !== undefined && !isUuid(integrationId))) return [];
  const { rows } = await db.query<KeyRow>(
    `select ${KEY_COLUMNS} from api_keys
      where tenant_id = $1 and ($2::uuid is null or integration_id = $2)
      order by created_at, id`,
    [tenantId, integrationId ?? null],
  );
  return rows.map(keyFromRow);
}

/** Revoke a key of this tenant. False when there is no such live key. */
export async function revokeApiKey(
  db: ControlQueryable,
  tenantId: string,
  keyId: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    "update api_keys set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null",
    [keyId, tenantId],
  );
  return rowCount === 1;
}

export type Authenticated = { tenant: TenantRecord; keyId: string; integration: IntegrationRecord };

/**
 * Resolve a presented key to its tenant and integration, or undefined. Looks the row up by id, compares the secret's
 * hash in constant time, and refuses revoked keys and keys of a deleted integration. Does not look at the tenant's
 * status: the caller decides.
 */
export async function authenticateApiKey(
  db: ControlQueryable,
  presented: string,
): Promise<Authenticated | undefined> {
  const parsed = parseApiKey(presented);
  if (!parsed) return undefined;
  const { rows } = await db.query<
    TenantRow & {
      key_hash: Buffer;
      revoked_at: Date | null;
      integration: { id: string; name: string; scopes: string[]; created_at: string };
      integration_deleted: boolean;
    }
  >(
    `select k.key_hash, k.revoked_at, i.deleted_at is not null as integration_deleted,
            json_build_object('id', i.id, 'name', i.name, 'scopes', i.scopes, 'created_at', i.created_at) as integration,
            ${TENANT_COLUMNS.split(", ")
              .map((c) => `t.${c}`)
              .join(", ")}
       from api_keys k join tenants t on t.id = k.tenant_id join integrations i on i.id = k.integration_id
      where k.id = $1`,
    [parsed.id],
  );
  const row = rows[0];
  // Compare even when the row is missing, so timing does not reveal which key ids exist.
  const expected = row?.key_hash ?? Buffer.alloc(32);
  const matches = timingSafeEqual(expected, hash(parsed.secret));
  if (!row || !matches || row.revoked_at || row.integration_deleted) return undefined;
  // Recording use is bookkeeping, at most once a minute per key.
  await db.query(
    "update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')",
    [parsed.id],
  );
  return {
    tenant: tenantFromRow(row),
    keyId: parsed.id,
    integration: integrationFromRow({
      id: row.integration.id,
      tenant_id: row.id,
      name: row.integration.name,
      scopes: row.integration.scopes,
      created_at: new Date(row.integration.created_at),
    }),
  };
}
