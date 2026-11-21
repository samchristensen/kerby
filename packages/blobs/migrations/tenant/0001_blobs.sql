-- The blob index: one row per object this tenant stored. Bytes live in S3 under `object_key`.
create table blobs (
  id uuid primary key default gen_random_uuid(),
  -- full object key, `t/<tenantId>/<key>`; checked against the caller's tenant on every read
  object_key text not null unique,
  kind text not null,
  media_type text not null,
  size bigint not null,
  sha256 text not null,
  conversation_id uuid,
  created_at timestamptz not null default now()
);
create index blobs_conversation_idx on blobs (conversation_id) where conversation_id is not null;
