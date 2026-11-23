// A tenant's model keys (bring your own key): one sealed row per provider in `tenant_secrets`, named
// `model-key/<provider>`. The api seals (public key only); the worker opens inside a run.
import { type ControlQueryable, isUuid } from "@kerby/db";
import { type Opener, type Sealer, secretContext } from "@kerby/secrets";

/** More providers than any tenant needs; stops a tenant filling the table with made-up names. */
export const MAX_MODEL_KEYS_PER_TENANT = 32;

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PREFIX = "model-key/";

export class ModelKeyLimitError extends Error {
  override name = "ModelKeyLimitError";
}

/** A provider id as Kerby model ids spell it (`anthropic` in `anthropic/claude-...`). */
const isProviderId = (value: string): boolean => PROVIDER.test(value);

function secretName(provider: string): string {
  if (!isProviderId(provider)) throw new Error(`"${provider}" is not a provider id (a-z, 0-9, -)`);
  return `${PREFIX}${provider}`;
}

/** Store or replace the tenant's key for a provider. */
export async function putModelKey(
  db: ControlQueryable,
  sealer: Sealer,
  tenantId: string,
  provider: string,
  apiKey: string,
): Promise<void> {
  const name = secretName(provider);
  const { rowCount } = await db.query(
    `insert into tenant_secrets (tenant_id, name, ciphertext)
     select $1::uuid, $2, $3
      where (select count(*) from tenant_secrets where tenant_id = $1::uuid) < $4
         or exists (select 1 from tenant_secrets where tenant_id = $1::uuid and name = $2)
     on conflict (tenant_id, name) do update set ciphertext = excluded.ciphertext, created_at = now()`,
    [tenantId, name, sealer.seal(apiKey, secretContext(tenantId, name)), MAX_MODEL_KEYS_PER_TENANT],
  );
  if (rowCount === 0) {
    throw new ModelKeyLimitError(
      `a tenant may hold at most ${MAX_MODEL_KEYS_PER_TENANT} model keys`,
    );
  }
}

/** The providers the tenant has a key for. Never the keys. */
export async function listModelKeys(
  db: ControlQueryable,
  tenantId: string,
): Promise<{ provider: string; createdAt: Date }[]> {
  if (!isUuid(tenantId)) return [];
  const { rows } = await db.query<{ name: string; created_at: Date }>(
    "select name, created_at from tenant_secrets where tenant_id = $1 and name like $2 order by name",
    [tenantId, `${PREFIX}%`],
  );
  return rows.map((row) => ({
    provider: row.name.slice(PREFIX.length),
    createdAt: row.created_at,
  }));
}

export async function hasModelKey(
  db: ControlQueryable,
  tenantId: string,
  provider: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    "select 1 from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, secretName(provider)],
  );
  return rowCount === 1;
}

/** Returns whether a key was removed. */
export async function deleteModelKey(
  db: ControlQueryable,
  tenantId: string,
  provider: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    "delete from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, secretName(provider)],
  );
  return rowCount === 1;
}

/** The tenant's key for a provider, opened. Call it inside a run and keep the value out of logs and errors. */
export async function readModelKey(
  db: ControlQueryable,
  opener: Opener,
  tenantId: string,
  provider: string,
): Promise<string | undefined> {
  const name = secretName(provider);
  if (!isUuid(tenantId)) return undefined;
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    "select ciphertext from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, name],
  );
  const row = rows[0];
  return row ? opener.open(row.ciphertext, secretContext(tenantId, name)) : undefined;
}
