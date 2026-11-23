-- Who started a conversation (ADR 0020): an integration's id from the control database, or null for a person in the
-- console. A key without the `tenant` scope sees only its integration's conversations.
alter table conversations add column integration_id uuid;
create index conversations_integration_idx on conversations (integration_id, updated_at desc, id desc);
