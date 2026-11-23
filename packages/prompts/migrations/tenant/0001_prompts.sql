-- Prompts (ADR 0017): named, versioned instructions of two kinds, `chat` (a system prompt, its variables, model and
-- guardrails) and `decision` (a judgment's questions and model). A prompt has one draft (`draft`, the shape is
-- PromptBodySchema in packages/contracts) whose revision goes up with each save; publishing copies the draft into
-- `prompt_versions` as the next version (1, 2, ...), never changed or deleted after. A label points at one version and
-- moves; `latest` is implied (the highest version) and never stored. `draft_bytes` and `bytes` are the bodies' sizes as
-- JSON: they count against the tenant's storage quota with the blob index.
create table prompts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check (kind in ('chat', 'decision')),
  draft jsonb not null,
  draft_bytes bigint not null,
  draft_revision integer not null default 0,
  draft_updated_at timestamptz not null default now(),
  draft_updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table prompt_versions (
  prompt_id uuid not null references prompts (id),
  version integer not null check (version >= 1),
  body jsonb not null,
  bytes bigint not null,
  note text,
  published_at timestamptz not null default now(),
  published_by text not null,
  primary key (prompt_id, version)
);

create table prompt_labels (
  prompt_id uuid not null,
  label text not null check (label <> 'latest'),
  version integer not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (prompt_id, label),
  foreign key (prompt_id, version) references prompt_versions (prompt_id, version)
);
