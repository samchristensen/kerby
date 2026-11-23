-- OAuth connections to tool servers (ADR 0022, MCP's authorization spec). A server with `auth = 'oauth'` is connected
-- once for the whole tenant from the console; its tokens are sealed in the control plane as `tool-credential/<id>`, like
-- a header's value. `auth_scope` is the scope to ask for (null: what the server's challenge or metadata names).
alter table tool_servers drop constraint tool_servers_auth_check;
alter table tool_servers add constraint tool_servers_auth_check
  check (auth in ('none', 'header', 'oauth'));
alter table tool_servers add column auth_scope text;
alter table tool_servers add constraint tool_servers_auth_scope_check
  check (auth = 'oauth' or auth_scope is null);

-- A connection the console started and the authorization server has not answered yet: what the api must read back when
-- the person's browser returns (RFC 6749 state, RFC 7636 verifier, RFC 9207 issuer, RFC 8707 resource). Found only by
-- the hash of its `state`, used once (deleted when read), dead after `expires_at` (ten minutes). It is plaintext: the
-- api, which holds only the public key, must read it back, and nothing in it is a token. The verifier and a dynamically
-- registered client's secret are worth nothing without the authorization code the person's browser carries, and they
-- die with the row.
create table tool_oauth_flows (
  state_hash text primary key,
  server_id uuid not null references tool_servers (id) on delete cascade,
  -- the server's URL when the flow began: a server moved since gets no token meant for its old address
  server_url text not null,
  code_verifier text not null,
  issuer text not null,
  -- the issuer said it puts `iss` in every answer (RFC 9207): an answer without it is refused
  iss_required boolean not null,
  token_endpoint text not null,
  client_id text not null,
  client_secret text,
  client_auth text not null check (client_auth in ('none', 'client_secret_basic', 'client_secret_post')),
  redirect_uri text not null,
  resource text not null,
  scope text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index tool_oauth_flows_server_idx on tool_oauth_flows (server_id, created_at);
