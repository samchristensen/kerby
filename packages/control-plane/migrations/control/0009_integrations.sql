-- Integrations (ADR 0020): a named principal of a tenant that owns API keys, scopes and event subscriptions. Deleting
-- one keeps the row (`deleted_at`), as revoking a key keeps the key's.
create table integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  name text not null,
  -- `packages/contracts` SCOPES
  scopes text[] not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index integrations_name_idx on integrations (tenant_id, name) where deleted_at is null;

-- Every key belongs to an integration. The keys made before integrations move into one `default` integration per
-- tenant holding every scope, so each keeps doing what it did.
insert into integrations (tenant_id, name, scopes)
select id, 'default', array['conversations', 'judgments', 'events', 'tenant', 'admin'] from tenants;
alter table api_keys add column integration_id uuid references integrations (id);
update api_keys k set integration_id = i.id from integrations i where i.tenant_id = k.tenant_id;
alter table api_keys alter column integration_id set not null;
create index api_keys_integration_idx on api_keys (integration_id);

-- Event subscriptions (ADR 0019): where an integration's events are pushed. The cursor and the delivery log live in
-- the tenant's database (packages/events); this row is configuration, read by the api and the dispatcher.
create table subscriptions (
  id uuid primary key,
  tenant_id uuid not null references tenants (id),
  integration_id uuid not null references integrations (id),
  -- `packages/contracts` DestinationConfigSchema, e.g. {"kind": "webhook", "url": "..."}
  destination jsonb not null,
  -- event type patterns: `turn.completed`, `turn.*`, `*`
  types text[] not null,
  scope text not null check (scope in ('own', 'tenant')),
  description text not null default '',
  -- the signing secret, sealed to the dispatcher's key pair (packages/secrets); the api cannot open it
  secret bytea not null,
  -- after a rotation the old secret signs too, until it expires
  previous_secret bytea,
  previous_secret_expires_at timestamptz,
  -- `deleted` is a tombstone: the dispatcher cancels its queued deliveries and drops its cursor in the tenant's
  -- database (which the console cannot reach), then removes the row
  state text not null default 'active' check (state in ('active', 'disabled', 'deleted')),
  disabled_reason text,
  -- since when every delivery has failed; null while healthy
  failing_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_tenant_idx on subscriptions (tenant_id);
create index subscriptions_integration_idx on subscriptions (integration_id);

-- api: read integrations to authenticate, manage subscriptions; dispatcher (same role): read them and record health.
grant select on integrations to kerby_app;
grant select, insert, update, delete on subscriptions to kerby_app;

-- console: make, re-scope and delete integrations and their keys; deleting one deletes its subscriptions
grant select, insert, update (name, scopes, deleted_at) on integrations to kerby_console;
grant select (integration_id) on api_keys to kerby_console;
grant insert (integration_id) on api_keys to kerby_console;
grant select (id, tenant_id, integration_id, state) on subscriptions to kerby_console;
grant update (state, updated_at) on subscriptions to kerby_console;
