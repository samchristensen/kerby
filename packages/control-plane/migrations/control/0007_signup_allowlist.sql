-- Sign-up is by invitation (ADR 0014, amended): control refuses a sign-up whose email is not on this list, and an
-- admin edits the list in the console. An admin is a console person the operator marked, over control's operator API;
-- the console's role can read the flag and never write it, so no console bug can make an admin.
alter table console_users add column is_admin boolean not null default false;

-- global: the platform's own list of who may sign up, before any tenant exists
create table signup_allowlist (
  -- trimmed and lower-cased, as `console_users.email` is
  email text primary key check (email = lower(btrim(email))),
  -- who added it; null for the people who had signed up before the list existed, and once that person is deleted
  added_by uuid references console_users (id) on delete set null,
  added_at timestamptz not null default now()
);

-- Everyone who has an account keeps being allowed.
insert into signup_allowlist (email) select email from console_users;

grant select, insert, delete on signup_allowlist to kerby_console;
