-- The operator-owned control database (ADR 0004). Every table names its tenant or says it is global.

-- global: the tenant registry itself; each row is one tenant
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleting', 'deleted')),
  plan text not null default 'default',
  -- per-tenant limits, e.g. {"maxConcurrentTurns": 4}; absent keys take the plan's defaults
  limits jsonb not null default '{}',
  region text not null default 'local',
  -- where the tenant's database lives; the role password is derived, never stored (see provisioning)
  db_host text not null,
  db_port integer not null,
  db_name text not null,
  db_role text not null,
  -- last tenant migration applied by the fan-out, `<workspace>/<file>`
  schema_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name),
  unique (db_name)
);

create table api_keys (
  -- the public part of the key: `kb_<id>_<secret>`; looked up by id, secret compared by hash
  id text primary key,
  tenant_id uuid not null references tenants (id),
  label text not null default '',
  key_hash bytea not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_tenant_idx on api_keys (tenant_id);

create table tenant_secrets (
  tenant_id uuid not null references tenants (id),
  name text not null,
  -- envelope-encrypted by packages/secrets; never plaintext
  ciphertext bytea not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, name)
);

create table usage (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  at timestamptz not null default now(),
  -- one row per assistant message: the worker retries, this makes it idempotent
  dedupe_key text not null,
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  cost_usd numeric(14, 6),
  unique (tenant_id, dedupe_key)
);
create index usage_tenant_at_idx on usage (tenant_id, at);

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- null for an action that is not about one tenant
  tenant_id uuid,
  actor text not null,
  action text not null,
  -- identifiers and counts only: never message content or secrets
  detail jsonb not null default '{}'
);
create index audit_log_tenant_at_idx on audit_log (tenant_id, at);
