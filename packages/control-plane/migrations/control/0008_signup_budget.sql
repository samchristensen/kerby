-- The global sign-up budget (control's SIGNUP_BUDGET_PER_HOUR): control counts the console sign-ups started in the last hour, each an
-- audit row `console.signup.attempt` written before its tenant is provisioned (`reserveConsoleSignup`). This keeps
-- that count to the hour's rows instead of the whole log.
create index audit_log_signup_attempt_idx on audit_log (at) where action = 'console.signup.attempt';
