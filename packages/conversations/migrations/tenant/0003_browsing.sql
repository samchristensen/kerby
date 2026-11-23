-- Browsing conversations (the console lists every one of a tenant's, however it began). `title` is the opening words of
-- the first user message, set once when that message is posted; `updated_at` is when a message was last added, the
-- list's order. Conversations from before this migration have no title: the list shows them by model and date.
alter table conversations
  add column title text,
  add column updated_at timestamptz not null default now();

update conversations c
   set updated_at = coalesce((select max(m.created_at) from messages m where m.conversation_id = c.id), c.created_at);

create index conversations_updated_idx on conversations (updated_at desc, id desc);
