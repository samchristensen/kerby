-- A conversation's trace (ADR 0018): everything its runs reported, beside the messages. An entry is a few lines of JSON;
-- entries are stored a segment at a time, one object in S3 (see blobs, kind `trace`) holding a run's entries `first_n`
-- to `last_n`, and this row is the index. Unlike `messages` the index is not fenced and not needed to resume: a run
-- whose lease lapsed still happened, and its entries are the audit of it. `id` is the order segments were recorded in.
create table trace_segments (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  -- the Absurd run that reported the entries: one per attempt
  run_id text not null,
  attempt integer not null check (attempt > 0),
  first_n integer not null check (first_n > 0),
  last_n integer not null check (last_n >= first_n),
  blob_id uuid not null references blobs (id),
  created_at timestamptz not null default now(),
  unique (conversation_id, run_id, first_n)
);
create index trace_segments_conversation_idx on trace_segments (conversation_id, id);
