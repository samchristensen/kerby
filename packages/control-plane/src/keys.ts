// API keys look like `kb_<id>_<secret>`. The id is public and indexes the row; only a hash of the secret is
// stored. The secret is 256 random bits, so a plain SHA-256 is enough: there is nothing to brute-force.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IntegrationRole } from "@kerby/contracts";
import type { ControlQueryable } from "@kerby/db";
import { IntegrationNotFoundError } from "./integrations.ts";
import { TENANT_COLUMNS, type TenantRecord, type TenantRow, tenantFromRow } from "./tenants.ts";

export type ApiKeyRecord = {
  id: string;
  tenantId: string;
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
 * Create a key in one of the tenant's live integrations. The returned `secret` is the whole key, shown once and never
 * stored. Throws `IntegrationNotFoundError` for an archived integration or another tenant's.
 */
export async function createApiKey(
  db: ControlQueryable,
  tenantId: string,
  integrationId: string,
  label = "",
): Promise<CreatedKey> {
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  // `for share` waits for a concurrent archive and then sees it, so no live key lands in an archived integration.
  const { rows } = await db.query<KeyRow>(
    `insert into api_keys (id, tenant_id, integration_id, label, key_hash)
     select $1, i.tenant_id, i.id, $4, $5 from integrations i
      where i.id::text = $3 and i.tenant_id::text = $2 and i.archived_at is null
      for share
     returning ${KEY_COLUMNS}`,
    [id, tenantId, integrationId, label, hash(secret)],
  );
  const row = rows[0];
  if (!row)
    throw new IntegrationNotFoundError(
      `integration ${integrationId} is not a live integration of tenant ${tenantId}. Fix: create the key in one of the tenant's integrations`,
    );
  return { key: keyFromRow(row), secret: `kb_${id}_${secret}` };
}

export async function listApiKeys(db: ControlQueryable, tenantId: string): Promise<ApiKeyRecord[]> {
  const { rows } = await db.query<KeyRow>(
    `select ${KEY_COLUMNS} from api_keys where tenant_id::text = $1 order by created_at, id`,
    [tenantId],
  );
  return rows.map(keyFromRow);
}

/** Revoke a key of this tenant. False when there is no such live key. */
export async function revokeApiKey(
  db: ControlQueryable,
  tenantId: string,
  keyId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "update api_keys set revoked_at = now() where id = $1 and tenant_id::text = $2 and revoked_at is null",
    [keyId, tenantId],
  );
  return rowCount === 1;
}

export type Authenticated = {
  tenant: TenantRecord;
  keyId: string;
  integration: { id: string; name: string; role: IntegrationRole };
};

/**
 * Resolve a presented key to its tenant and integration, or undefined. Looks the row up by id, compares the secret's hash in
 * constant time, and refuses revoked keys and keys of an archived integration. Does not look at the tenant's status: the caller decides.
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
      integration_id: string;
      integration_name: string;
      integration_role: IntegrationRole;
      integration_archived_at: Date | null;
    }
  >(
    `select k.key_hash, k.revoked_at, i.id as integration_id, i.name as integration_name,
            i.role as integration_role, i.archived_at as integration_archived_at, ${TENANT_COLUMNS.split(
              ", ",
            )
              .map((c) => `t.${c}`)
              .join(", ")}
       from api_keys k join tenants t on t.id = k.tenant_id
       join integrations i on i.id = k.integration_id where k.id = $1`,
    [parsed.id],
  );
  const row = rows[0];
  // Compare even when the row is missing, so timing does not reveal which key ids exist.
  const expected = row?.key_hash ?? Buffer.alloc(32);
  const matches = timingSafeEqual(expected, hash(parsed.secret));
  if (!row || !matches || row.revoked_at || row.integration_archived_at) return undefined;
  // Recording use is bookkeeping, at most once a minute per key.
  await db.query(
    "update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')",
    [parsed.id],
  );
  return {
    tenant: tenantFromRow(row),
    keyId: parsed.id,
    integration: { id: row.integration_id, name: row.integration_name, role: row.integration_role },
  };
}
