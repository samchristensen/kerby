-- A chat prompt names the tools its conversations may call (ADR 0022); none named, none offered. Bodies stored before
-- that get an empty list, so every chat body read back has `tools`. A published version is otherwise never changed:
-- an empty list is what it meant.
update prompts set draft = draft || '{"tools": []}'::jsonb where kind = 'chat' and not draft ? 'tools';
update prompt_versions v set body = v.body || '{"tools": []}'::jsonb
  from prompts p
 where p.id = v.prompt_id and p.kind = 'chat' and not v.body ? 'tools';
