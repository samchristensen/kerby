# 0009. A random password per tenant database role, stored sealed in the control plane

- Status: proposed
- Date: 2026-11-22

## Context

Each tenant database is owned by its own role ([0004](0004-database-per-tenant.md)). Until now that role's password was
an HMAC of one cluster secret (`TENANT_DB_SECRET`) and the tenant id, held by control, api and worker. Nothing was
stored, but that one secret opened every tenant database, and no single tenant's password could change without changing
everyone's. The api and the worker must open a tenant's database to serve it, so whatever they hold must yield the
password.

## Decision

- **A random password per tenant.** 32 random bytes (base64url), made by control when it provisions the tenant and
  whenever an operator rotates it (`POST /v1/operator/tenants/:id/rotate-db-password`). It is never derived from anything
  else, so learning one tells nothing about another.
- **Stored sealed in the control plane** (`tenant_db_credentials`, one row per tenant). `packages/secrets` seals it with
  AES-256-GCM (Node's `crypto`, no dependency) under a symmetric key list, `TENANT_DB_KEYS`: comma-separated base64
  32-byte keys; the first seals, every key opens. The ciphertext names its key (8 bytes of a hash of it), and the tenant id
  is authenticated data: a ciphertext copied to another tenant's row fails to open. `kerby_app` may read the table.
- **Held by control, api and worker.** Not the [ADR 0008](0008-byok-sealed-secrets.md) sealed pair: the api must open the
  credential to connect, and the api must never hold the model-key private key, which only the worker has. A separate key
  also keeps the two rotations independent.
- **Connections follow the stored password.** `TenantPools` resolves a tenant's URL from its row and stored credential
  (`resolveTenantDbUrl`). A pool asks for the password on every new connection; when Postgres refuses it (`28P01`), the
  pool resolves once more and retries that connect, so a rotation reaches every process without a restart. The pool
  object stays, because Absurd holds it for the length of a turn. Sessions already open keep working: Postgres checks
  passwords only at login.
- **Rotation.** Storing the new ciphertext and `alter role ... password` run in one control transaction, row locked: two
  rotations at once leave the role and the row agreeing, and a failed `alter role` stores nothing.
- **Control repairs at startup.** It gives every tenant that has a role and no stored credential a fresh password
  (`alter role` + store, skipped when another replica stored one first), and re-seals with the first key every credential
  sealed to an older one. Both are idempotent and run on every start. A credential that no key opens stops control with
  the fix in the message.
- **Losing the keys is recoverable.** Unlike the ADR 0008 private key, a lost `TENANT_DB_KEYS` strands nothing: set a new
  key, delete the rows of `tenant_db_credentials`, restart control, and every tenant gets a new password.
- **Rollout: a clean cutover.** Kerby has no paying tenants, so there is no expand-then-contract. Deploy control first: its
  migration adds the table and its startup gives every existing tenant a random password. Then deploy api and worker.
  In between, new connections from the old api and worker (still using the derived password) fail; open ones keep
  working. Accepted before launch.

## Consequences

- No one secret opens every tenant database by itself: an attacker needs `TENANT_DB_KEYS` and a read of the control
  database. Anyone holding both (control, api or worker compromised, or the Railway login) still reaches every tenant;
  the gain is that a leaked password or key can be rotated without a lockout.
- One extra control-plane read on a pool's cold open and after a refused connection; none per query.
- Rotating `TENANT_DB_KEYS` and a tenant's password are runbook steps in [deploy.md](../deploy.md).
- Rejected: storing passwords in plaintext (a control dump would open every tenant); the ADR 0008 pair (puts the private
  key on the api); a key-management service (Railway has none, ADR 0007); client certificates (Railway's private network
  has no TLS).
