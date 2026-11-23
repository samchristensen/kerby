-- Tools (ADR 0022): the tenant's remote MCP servers, the tools each one lists, which integrations may use them, and the
-- tools each conversation names. Grants and conversation tools hold server ids, never slugs, so a server deleted and
-- made again under the same slug inherits neither. Integrations live in the control plane, so `integration_id` has no
-- foreign key here; a server's deletion takes its grants and conversation tools with it.
--
-- The server `kerby` serves Kerby's own tools from code: it is the one `builtin` row, has no URL and no `tools` rows,
-- and a tenant's server can never take its slug.
create table tool_servers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,23}$'),
  kind text not null check (kind in ('mcp', 'builtin')),
  url text,
  auth text not null default 'none' check (auth in ('none', 'header')),
  -- the header the credential is sent in; its value is sealed in the control plane as `tool-credential/<id>`
  auth_header text,
  -- `syncing` until a worker has listed the tools (again, after a change); `error` keeps why in `last_error`
  status text not null default 'syncing' check (status in ('syncing', 'ready', 'error')),
  last_error text,
  -- when a listing last succeeded: the tools below are as of then
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'builtin') = (url is null)),
  check ((kind = 'builtin') = (slug = 'kerby')),
  check ((auth = 'header') = (auth_header is not null))
);
insert into tool_servers (slug, kind, status, synced_at) values ('kerby', 'builtin', 'ready', now());

-- A server's definitions go straight into the model's context and may change at any time, so the model sees `pinned`,
-- which only follows `listed` while the tool is disabled or when an admin accepts the new one: an enabled tool whose
-- listing changed is drifted (`listed <> pinned`, computed). A tool the server stops listing is kept with `removed_at`
-- (not offered) so that it comes back with its settings. `effect` is the tenant's word, never the server's hints.
create table tools (
  server_id uuid not null references tool_servers (id) on delete cascade,
  name text not null,
  listed jsonb not null,
  pinned jsonb not null,
  enabled boolean not null default false,
  effect text not null default 'write' check (effect in ('read', 'write')),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (server_id, name)
);

-- The grants: a null `tool` is the whole server, so a tool enabled later is covered too. A grant names a tool by name,
-- not by row, so it outlives the tool's removal and covers it again when the server lists it again.
create table integration_tools (
  integration_id uuid not null,
  server_id uuid not null references tool_servers (id) on delete cascade,
  tool text,
  created_at timestamptz not null default now()
);
create unique index integration_tools_grant_idx
  on integration_tools (integration_id, server_id, coalesce(tool, ''));
create index integration_tools_server_idx on integration_tools (server_id);

-- What each conversation named, as ids, in the order it named them; a null `tool` is every tool of the server that is
-- enabled at each turn.
create table conversation_tools (
  conversation_id uuid not null references conversations (id) on delete cascade,
  server_id uuid not null references tool_servers (id) on delete cascade,
  tool text,
  position integer not null,
  unique (conversation_id, position)
);
create unique index conversation_tools_tool_idx
  on conversation_tools (conversation_id, server_id, coalesce(tool, ''));
create index conversation_tools_server_idx on conversation_tools (server_id);
