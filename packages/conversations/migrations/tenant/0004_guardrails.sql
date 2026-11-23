-- Guardrails (ADR 0016). `conversations.guardrails` is the policy chosen when the conversation was created: a list of
-- yes/no conditions checked on a user message or a tool call (the shape is GuardrailSchema in packages/contracts).
-- `messages.blocked_by` names the guardrails that blocked a message, set on the user message and on the refusal the
-- worker wrote for it; a blocked message stays in the index (the tenant can read it) but is never rehydrated into a turn.
alter table conversations add column guardrails jsonb not null default '[]'::jsonb;
alter table messages add column blocked_by text[];
