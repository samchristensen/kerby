-- Each tenant role's database password (ADR 0009): 32 random bytes, sealed by packages/secrets' secret box under
-- TENANT_DB_KEYS with the tenant id as authenticated data. This replaces the password derived from TENANT_DB_SECRET
-- (0001's "never stored" note on `tenants`): control writes a row at provisioning, rotation and startup.
create table tenant_db_credentials (
  tenant_id uuid primary key references tenants (id),
  -- never plaintext
  ciphertext bytea not null,
  rotated_at timestamptz not null default now()
);

-- api and worker open tenant databases, so they read the credential; only control writes it.
grant select on tenant_db_credentials to kerby_app;
