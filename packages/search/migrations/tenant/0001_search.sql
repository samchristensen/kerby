-- The chat search index (ADR 0021): pieces of user and assistant text, with a full-text vector and, once the tenant
-- chooses an embedding model, an embedding. Derived data: it may lag a turn, and every row cascades with its message.
--
-- `vector` is not a trusted extension, so a tenant role cannot create it: control installs it as the admin in the
-- template and in every tenant database before migrating (`ClusterAdmin.ensureExtension`), and this is then a no-op.
create extension if not exists vector;

-- One row: the embedding model (null: keyword search only), a `generation` bumped whenever the model changes (a
-- backfill of an older generation stops), why indexing last failed for good (a provider's refusal), and when the model
-- was last set (null until it first is: a tenant database is a copy of the template, whose clock means nothing here).
create table search_settings (
  id boolean primary key default true check (id),
  embedding_model text,
  generation integer not null default 0,
  last_error text,
  updated_at timestamptz
);
insert into search_settings default values;

-- How far each conversation is chunked: messages up to `indexed_seq` are in `search_chunks`. A batch advances it only
-- if it is still where the batch read it, so duplicate or concurrent index tasks write nothing twice.
create table search_progress (
  conversation_id uuid primary key references conversations (id) on delete cascade,
  indexed_seq integer not null check (indexed_seq >= 0),
  updated_at timestamptz not null default now()
);

-- A piece of one message's text (`part` from 0). Embeddings of any dimension share the column, told apart by
-- `embedding_model`; a search scans them exactly (no ANN index yet: see ADR 0021 for when to add one).
create table search_chunks (
  conversation_id uuid not null,
  seq integer not null,
  part integer not null check (part >= 0),
  role text not null check (role in ('user', 'assistant')),
  text text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  embedding halfvec,
  embedding_model text,
  -- the message's time, for showing a hit
  created_at timestamptz not null,
  primary key (conversation_id, seq, part),
  foreign key (conversation_id, seq) references messages (conversation_id, seq) on delete cascade
);
create index search_chunks_tsv_idx on search_chunks using gin (tsv);

-- A database that already has conversations indexes them in the background: the first `index-backfill` page
-- (`TASKS` in packages/durable, queue `index`; options as `spawnInTx` writes them, ADR 0021). A new database has
-- nothing to index, and each turn indexes its own conversation from then on.
select absurd.spawn_task(
  'index',
  'index-backfill',
  '{"generation":0,"after":null}'::jsonb,
  '{"idempotency_key":"backfill:0:start","max_attempts":5,"retry_strategy":{"kind":"exponential","base_seconds":5,"factor":2,"max_seconds":300}}'::jsonb
)
where exists (select 1 from conversations);
