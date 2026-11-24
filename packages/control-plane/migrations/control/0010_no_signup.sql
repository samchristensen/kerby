-- A self-hosted install (ADR 0024) has no sign-up: control keeps the one configured admin's account, so the sign-up
-- allowlist and the operator's admin flag go.
drop table signup_allowlist;
alter table console_users drop column is_admin;
