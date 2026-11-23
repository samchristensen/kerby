-- The event log (ADR 0019): the outbox every emitting transaction writes to, read by `GET /v1/events` and fanned out
-- to subscriptions. A reader sees a row only once every transaction older than the row's has finished
-- (`tx < pg_snapshot_xmin(pg_current_snapshot())`), so a cursor of `(tx, position)` never skips a late commit.
create table events (
  id uuid primary key default gen_random_uuid(),
  -- the writing transaction: rows become visible in commit order, which `position` alone does not give
  tx xid8 not null default pg_current_xact_id(),
  position bigint generated always as identity,
  type text not null,
  -- the integration whose work it is (control database, ADR 0020); null for the console's
  integration_id uuid,
  conversation_id uuid,
  -- one event per fact, whoever retries the transaction: `message:<conversation>:<seq>`, `turn:<conversation>:<seq>:outcome`
  dedupe_key text not null unique,
  -- `packages/contracts` EventData of `type`: ids and status, never content
  data jsonb not null,
  created_at timestamptz not null default now()
);
create unique index events_order_idx on events (tx, position);
create index events_created_idx on events (created_at);

-- Where each subscription's fan-out is: the next read starts after it. The subscription itself is in the control
-- database; a cursor without one is left behind harmlessly.
create table subscription_cursors (
  subscription_id uuid primary key,
  tx xid8 not null,
  position bigint not null,
  updated_at timestamptz not null default now()
);

-- Every attempt to deliver to a subscription, for the tenant to read (`GET /v1/subscriptions/:id/deliveries`).
create table delivery_attempts (
  id bigint generated always as identity primary key,
  subscription_id uuid not null,
  event_ids uuid[] not null,
  attempt integer not null,
  outcome text not null check (outcome in ('delivered', 'failed', 'gone')),
  will_retry boolean not null,
  status integer,
  error text,
  -- the start of the endpoint's answer, at most 1 KiB
  response text,
  duration_ms integer not null,
  at timestamptz not null default now()
);
create index delivery_attempts_subscription_idx on delivery_attempts (subscription_id, id desc);
create index delivery_attempts_at_idx on delivery_attempts (at);
