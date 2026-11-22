# Tech debt

One line each: what, why it matters, what fixes it. Remove the line in the commit that pays it.

- `knip` (dead code, unused dependencies) is not wired into `make check`. Add it with the first service.
- The import scanner in `check-architecture.ts` is regex-based and also reads strings in comments. Replace it with a parser if a false positive appears.
- No automated doc-freshness pass. A recurring agent task could compare ADR claims and AGENTS.md invariants with the checks.
- `AgentRuntime` has one adapter and no conformance suite. Write the suite when the second adapter lands.
- A tenant role can still `connect` to the maintenance database `postgres` (the control database is restricted at control startup). It has no grants there.
- `reassignOwned` (packages/db) moves ownership by hand because a superuser cannot `REASSIGN OWNED`, and the provisioning path for a non-superuser admin (admin made a member of each tenant role) is tested but unused on Railway, whose `postgres` role is a superuser. Delete both if no host needs them.
- A conversation read fetches every message body from S3 (N requests). Cache small bodies or page the read when it shows up in a profile.
- M3 asks that `make test` run against the real stack and that logs and traces be agent-queryable. Tests use disposable containers; logs are JSON on stdout (`make logs`). Add a log sink an agent can query when it is needed.
- Hosting (ADR 0007): no backups of the Postgres volume are configured. Set a Railway volume backup schedule, then restore one into a scratch environment before trusting it.
- Hosting: no alarms, dashboard or error alerting beyond Railway's logs and metrics. Add notifications (a webhook on deploy failure and crash) and log-based checks for failed turns and lost leases.
- Hosting: Postgres runs with the template's `max_connections` (100); each api or worker process may hold up to 50 tenant pools of 2 connections. Raise it (`ALTER SYSTEM`, restart) before the tenant count grows, or put a pooler in front.
- Hosting: one Postgres instance on one volume, no replica; a failed instance is a full outage until Railway restarts it.
- Hosting: whoever holds the Railway login can read every secret, and an agent that deploys uses the same login. Give agents a project token (`RAILWAY_TOKEN`) and measure what it can and cannot do.
- Hosting: no edge rate limiting or WAF in front of `api`; no external synthetic check.
- Hosting: `api` and `worker` never sleep (`deploy.sleepApplication` is off). Try it on `api` with event streams before relying on it; a scheduled task (plan 0001, M8) must also survive any sleep.
- Every tenant role's password derives from one shared secret held by api, worker and control. Store per-tenant credentials, with a rotation path, in `packages/secrets`.
- Tenant exports are written to the control container's disk, which a redeploy clears. Upload them to a separate, access-logged bucket location and return a presigned URL.
- Ephemeral environments are created and deleted by whoever runs `make railway-setup` and `make env-down`; CI cannot do it yet.
- Model keys (ADR 0008): the api accepts a key for any well-formed provider id; an unknown one fails at the first turn, not at `PUT`. Tenants set keys only by API; the console is M9. No automated re-seal after a secrets key rotation (re-`PUT`, or write a script when the first rotation happens).
- Secrets private key: lives only as a Railway variable on `worker`. Back it up outside Railway before real tenants store keys; there is no recovery otherwise.
- The tenant-role connection limit (`TENANT_ROLE_CONNECTION_LIMIT`, 50) is a guess; each api process also caps one tenant's open event streams (`MAX_STREAMS_PER_TENANT`, 20). Measure under load and set both from data, with `max_connections` (hosting line above).
- A tenant's concurrent-turn limit is counted per worker process, not per tenant: K workers allow K times `maxConcurrentTurns`. Count running tasks in the tenant database before claiming.
- No per-tenant request rate limit and no storage quota: a tenant can store up to 64 MiB in each of unboundedly many conversations. Meter and cap storage with usage in M8.
- A conversation is capped at 2000 messages and 64 MiB so a read or a turn cannot exhaust memory, but both still load the whole history. Page reads and give the worker a history budget (with the N-requests line above).
- Deleting a tenant keeps its export files on the control volume (they may be the hand-over copy). Decide a retention period and delete expired exports; see the export-bucket line above.
- Not built: `egress` (plan 0001, M2). Nothing calls a tenant-supplied URL yet (model providers are a fixed list, tools are M7); build it before the first tool or custom provider base URL.
