// A tool server's credential (ADR 0019): the value of the header it authenticates with, sealed like a model key in
// `tenant_secrets` under `tool-credential/<serverId>`. The name is authenticated data and carries the server's id, not
// its slug, so a deleted server's leftover row never opens for a new server under the same slug. The api and console
// seal (public key only); the worker opens inside the step that calls the server.
import type { ControlQueryable } from "@kerby/db";
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
  const { rowCount } = await db.query(
    "delete from tenant_secrets where tenant_id::text = $1 and name = $2",
    [tenantId, secretName(serverId)],
  );
  return rowCount === 1;
}

export async function hasToolCredential(
  db: ControlQueryable,
  tenantId: string,
  serverId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "select 1 from tenant_secrets where tenant_id::text = $1 and name = $2",
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
  const name = secretName(serverId);
  const { rows } = await db.query<{ ciphertext: Buffer }>(
    "select ciphertext from tenant_secrets where tenant_id::text = $1 and name = $2",
    [tenantId, name],
  );
  const row = rows[0];
  return row ? opener.open(row.ciphertext, secretContext(tenantId, name)) : undefined;
}
