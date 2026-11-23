-- Conversations started from a chat prompt (ADR 0017) record the version they were made from: the label in the request
-- is resolved once, at creation. The system prompt, model and guardrails are copied into the row as before, so a turn
-- never reads the prompt tables. Both columns are null for a conversation whose request wrote its own system prompt.
alter table conversations
  add column prompt_name text,
  add column prompt_version integer,
  add constraint conversations_prompt_pinned check ((prompt_name is null) = (prompt_version is null));
