-- Why the latest turn produced no answer; cleared when the next message is posted.
alter table conversations add column last_error text;

-- Every actual execution of a tool, once per tool call. `executions` counts real runs: a retried turn that gets the
-- stored result of a finished call (Absurd step) must leave it at 1.
create table tool_executions (
  conversation_id uuid not null references conversations (id) on delete cascade,
  call_id text not null,
  name text not null,
  executions integer not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (conversation_id, call_id)
);
