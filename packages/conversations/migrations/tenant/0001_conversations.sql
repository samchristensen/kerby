-- Conversations and their messages. A message's body is an object in S3 (see blobs); this row is the index and
-- the source of truth for order: `(conversation_id, seq)` is unique, so two writers cannot both claim a seq.
create table conversations (
  id uuid primary key default gen_random_uuid(),
  -- the tenant's own name for the end user; Kerby does not authenticate end users
  external_user_id text,
  model text not null,
  system text not null default '',
  created_at timestamptz not null default now()
);
create index conversations_external_user_idx on conversations (external_user_id) where external_user_id is not null;

create table messages (
  conversation_id uuid not null references conversations (id) on delete cascade,
  seq integer not null check (seq > 0),
  role text not null check (role in ('user', 'assistant', 'tool')),
  blob_id uuid not null references blobs (id),
  -- the Absurd run that wrote it (null for user messages): audit only, the fence is checked at insert
  run_id text,
  created_at timestamptz not null default now(),
  primary key (conversation_id, seq)
);
