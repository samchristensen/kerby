// A tool server's credential (ADR 0022): the value of the header it authenticates with, or the JSON of an OAuth
// connection's tokens, sealed like a model key in `tenant_secrets` under `tool-credential/<serverId>`. The name is
// authenticated data and carries the server's id, not its slug, so a deleted server's leftover row never opens for a new
// server under the same slug. The api and console seal (public key only); the worker opens inside the step that calls
// the server, and replaces an OAuth connection's tokens when it refreshes them (`updateToolCredential`).
import { type ControlDb, type ControlQueryable, isUuid } from "@kerby/db";
import { type Opener, type Sealer, secretContext } from "@kerby/secrets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function secretName(serverId: string): string {
  if (!UUID.test(serverId))
    throw new Error(`"${serverId}" is not a tool server id (a lowercase uuid)`);
  return `tool-credential/${serverId}`;
}

/** Store or replace the credential of a server. One per server, so the tenant's server limit bounds them. */
export async function putToolCredential(
  db: ControlQueryable,
  sealer: Sealer,
  tenantId: string,
  serverId: string,
  value: string,
): Promise<void> {
  const name = secretName(serverId);
  await db.query(
    `insert into tenant_secrets (tenant_id, name, ciphertext) values ($1, $2, $3)
     on conflict (tenant_id, name) do update set ciphertext = excluded.ciphertext, created_at = now()`,
    [tenantId, name, sealer.seal(value, secretContext(tenantId, name))],
  );
}

/** Returns whether a credential was removed. */
export async function deleteToolCredential(
  db: ControlQueryable,
  tenantId: string,
  serverId: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    "delete from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, secretName(serverId)],
  );
  return rowCount === 1;
}

export async function hasToolCredential(
  db: ControlQueryable,
  tenantId: string,
  serverId: string,
): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    "select 1 from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, secretName(serverId)],
  );
  return rowCount === 1;
}

/** The server's credential, opened. Call it inside the step that uses it and keep the value out of logs and errors. */
export async function readToolCredential(
  db: ControlQueryable,
  opener: Opener,
  tenantId: string,
  serverId: string,
): Promise<string | undefined> {
  if (!isUuid(tenantId)) return undefined;
  const name = secretName(serverId);
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    "select ciphertext from tenant_secrets where tenant_id = $1 and name = $2",
    [tenantId, name],
  );
  const row = rows[0];
  return row ? opener.open(row.ciphertext, secretContext(tenantId, name)) : undefined;
}

/**
 * Replace a server's credential based on what is stored, under a row lock held until the replacement is stored: two
 * workers refreshing one OAuth connection at once take turns, and the second sees the first's tokens (`change` gets
 * the value as stored now, not as the caller read it earlier). `change` returns the replacement, `undefined` to keep
 * the value, or `null` to delete it. Nothing happens when no credential is stored (the server was deleted or its auth
 * changed meanwhile): a refresh never brings a credential back. Resolves with what is stored afterwards.
 */
export async function updateToolCredential(
  db: ControlDb,
  keys: { opener: Opener; sealer: Sealer },
  tenantId: string,
  serverId: string,
  change: (current: string) => Promise<string | null | undefined>,
): Promise<string | undefined> {
  if (!isUuid(tenantId)) return undefined;
  const name = secretName(serverId);
  const context = secretContext(tenantId, name);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ ciphertext: Buffer }>(
      "select ciphertext from tenant_secrets where tenant_id = $1 and name = $2 for update",
      [tenantId, name],
    );
    const row = rows[0];
    if (!row) return undefined;
    const current = keys.opener.open(row.ciphertext, context);
    const next = await change(current);
    if (next === undefined) return current;
    if (next === null) {
      await tx.query("delete from tenant_secrets where tenant_id = $1 and name = $2", [
        tenantId,
        name,
      ]);
      return undefined;
    }
    await tx.query(
      "update tenant_secrets set ciphertext = $3, created_at = now() where tenant_id = $1 and name = $2",
      [tenantId, name, keys.sealer.seal(next, context)],
    );
    return next;
  });
}
