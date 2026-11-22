# Tech debt

One line each: what, why it matters, what fixes it. Remove the line in the commit that pays it. Plan
[0003](active/0003-tech-debt.md) schedules every line.

- `knip` (dead code, unused dependencies) is not wired into `make check`. Add it with the first service.
- The import scanner in `check-architecture.ts` is regex-based and also reads strings in comments. Replace it with a parser if a false positive appears.
- `AgentRuntime` has one adapter and no conformance suite. Write the suite when the second adapter lands.
- A conversation read and a turn's rehydrate fetch each message body from S3, one request per message (a page, or the history budget, at a time). Add a per-process body cache when a profile shows it (plan 0003, parked "Body cache").
- Alerts have no destination yet: `alert()` posts nowhere until `ALERT_WEBHOOK_URL` is set, and Railway's project webhook and Monitors are not configured (only its default email and in-app notifications). Make a Slack or Discord channel webhook, set it on control, api and worker and as the project webhook, add Monitors (docs/deploy.md#alerts), and see one alert arrive.
- Alert debounce is per process: with several worker replicas a storm posts once per replica per five minutes. Share the window (a control-database row) if replicas grow.
- Hosting: Postgres runs with the template's `max_connections` (100); each api or worker process may hold up to 50 tenant pools of 2 connections. Raise it (`ALTER SYSTEM`, restart) before the tenant count grows, or put a pooler in front.
- Bucket backup (ADR 0013): message bodies can lose up to a day (nightly copy), copies pass through control (each bucket has its own keys, so no server-side copy), and a failed run alerts but nothing alerts on a run that never happened (control down at 03:00 UTC).
- Hosting: whoever holds the Railway login can read every secret, and an agent that deploys uses the same login. Give agents a project token (`RAILWAY_TOKEN`) and measure what it can and cannot do.
- No edge proxy or WAF in front of `api` (the owner's call, 2026-11-22: not yet). Request and failed-auth limits are token buckets in each api process: N processes allow N times `requestsPerMinute`, and the failed-auth limit trusts Railway's `X-Forwarded-For` (left-most), which Railway does not publish as a contract. Move both to the edge or a shared counter when the api scales out or an edge lands.
- The `uptime` workflow checks `GET /healthz` only; nothing proves the database path from outside. Add an authenticated read by a canary tenant (its key as a repository secret).
- Exports (ADR 0013): a URL lives 24 h and cannot be reissued for an existing export; after a tenant is deleted its export stays 30 days but nobody can get a fresh URL for it. Add an operator route that presigns an existing export when a hand-over needs it.
- CI releases to production on merge (ADR 0011), but the `release` job skips until the repository secrets `RAILWAY_TOKEN` (a Railway project token for `production`; the CLI login cannot mint one) and `GHCR_PULL_TOKEN` (classic GitHub token, `read:packages` only) exist. A person creates both (docs/deploy.md, Releasing); then measure what the project token can and cannot do.
- IaC and buckets: an environment filled in from the file alone never gets its bucket deployed, so new environments are copies of production, which needs production to exist. An orphan bucket named `modular-safe-wx5G` was left in the project by a trial; delete it in the dashboard.
- Model keys (ADR 0008): tenants set keys only by API; the console is M9. No automated re-seal after a secrets key rotation (re-`PUT`, or write a script when the first rotation happens).
- The tenant-role connection limit (`TENANT_ROLE_CONNECTION_LIMIT`, 50) is a guess; each api process also caps one tenant's open event streams (`MAX_STREAMS_PER_TENANT`, 20). Measure under load and set both from data, with `max_connections` (hosting line above).
- Connections per api process have no ceiling: each event stream opens its own `LISTEN` connection and keeps its tenant's pool leased past `maxPools`, and only the per-tenant stream cap applies. Share one `LISTEN` connection per tenant database per process and cap streams per process.
- A tenant's concurrent-turn limit is counted per worker process, not per tenant: K workers allow K times `maxConcurrentTurns`. Count running tasks in the tenant database before claiming.
- Stored bytes are capped (`limits.storageBytes`) but not reported to `usage`; meter them with plan 0001, M8.
- A post refused by the quota re-check inside its transaction (a race with another conversation) leaves its object and blob row, which count toward the quota: `packages/blobs` has no per-object delete.
- Tenant limits are set only at provisioning; there is no operator endpoint to change them (SQL until plan 0001, M9).
