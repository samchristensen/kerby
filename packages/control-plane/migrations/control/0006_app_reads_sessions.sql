-- The api accepts a console session as a credential (ADR 0014, amended): it looks the session up as it looks up an API
-- key, so the browser's chat reaches the tenant's data through the one door that enforces limits and quotas. It reads
-- the session (a SHA-256 of a 256-bit token: no use to anyone who reads it) and never the person.
grant select on console_sessions to kerby_app;
