-- The tenant console (ADR 0014): the people who sign in, each belonging to one tenant, and their sessions. Control
-- inserts a person when it provisions their tenant at sign-up; the console checks passwords and keeps sessions,
-- connected as `kerby_console`, a role made here with only what the console does.
create table console_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  -- trimmed and lower-cased by the console: one account per address across every tenant
  email text not null unique,
  -- `scrypt$...`, made by the console (packages/contracts); never a password
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create index console_users_tenant_idx on console_users (tenant_id);

create table console_sessions (
  -- SHA-256 of the cookie's random token: reading this table signs no one in
  token_hash bytea primary key,
  tenant_id uuid not null references tenants (id),
  user_id uuid not null references console_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index console_sessions_user_idx on console_sessions (user_id);

do $$
begin
  create role kerby_console nologin;
exception
  -- unique_violation: another database's migration created it at the same moment
  when duplicate_object or unique_violation then null;
end
$$;

grant select on tenants to kerby_console;
-- create, list and revoke a tenant's keys; a key's hash is written once and never read back
grant select (id, tenant_id, label, created_at, last_used_at, revoked_at) on api_keys to kerby_console;
grant insert (id, tenant_id, label, key_hash) on api_keys to kerby_console;
grant update (revoked_at) on api_keys to kerby_console;
-- model keys, sealed to the public key as the api seals them (ADR 0008)
grant select, insert, update, delete on tenant_secrets to kerby_console;
grant insert on audit_log to kerby_console;
-- sign-in reads a person; only control inserts one
grant select on console_users to kerby_console;
grant update (last_login_at) on console_users to kerby_console;
grant select, insert, delete on console_sessions to kerby_console;
