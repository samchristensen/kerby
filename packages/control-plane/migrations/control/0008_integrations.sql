-- Integrations (ADR 0019): a tenant's named clients. Every API key belongs to one, and what a key may do is its
-- integration's role: `admin` everything, `restricted` conversations and judgments with only the tools it was granted.
create table integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  name text not null,
  role text not null check (role in ('admin', 'restricted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- an archived integration keeps its row (audit, grants by id) but frees its name, and its keys stop working
  archived_at timestamptz,
  -- the target of api_keys' composite foreign key: a key can only sit in its own tenant's integration
  unique (id, tenant_id)
);
create unique index integrations_live_name_idx on integrations (tenant_id, name) where archived_at is null;

-- Every tenant starts with an admin integration named `default`; every existing key joins it.
insert into integrations (tenant_id, name, role) select id, 'default', 'admin' from tenants;

alter table api_keys add column integration_id uuid;
update api_keys k set integration_id = i.id from integrations i where i.tenant_id = k.tenant_id and i.name = 'default';
alter table api_keys alter column integration_id set not null;
alter table api_keys add constraint api_keys_integration_fk
  foreign key (integration_id, tenant_id) references integrations (id, tenant_id);
create index api_keys_integration_idx on api_keys (integration_id);

-- the api reads a key's integration (its role) when it authenticates
grant select on integrations to kerby_app;
-- the console manages a tenant's integrations and puts each new key in one
grant select, insert on integrations to kerby_console;
grant update (name, role, updated_at, archived_at) on integrations to kerby_console;
grant select (integration_id) on api_keys to kerby_console;
grant insert (integration_id) on api_keys to kerby_console;
