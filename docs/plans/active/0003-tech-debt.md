# 0003. Pay down the tech debt

Goal: every line of [tech-debt.md](../tech-debt.md) is paid, closed by a recorded decision (an ADR, plan 0001), or
parked behind a named trigger. Each item quotes the start of its debt line; remove that line and tick the box in the same
commit. "Now" facts were checked against the code on 2026-11-22. Sizes: S under half a day, M one to two days, L more.

## Questions, all answered

- Where alerts go: a Slack channel through `ALERT_WEBHOOK_URL` (D2).
- Recovery targets: RPO 24 h, one instance until a tenant pays or an SLA is sold (ADR 0012).
- Export retention: 30 days, a deleted tenant's included (ADR 0013).
- History over the worker's budget: drop the oldest turns, cutting before a user message (F1).
- Git remote and CI host: GitHub, `samchristensen/kerby` (ADR 0011).
- An edge in front of `api`: not yet (the owner's call, 2026-11-22; a tech-debt line). The monitor is the `uptime` workflow.

## Order

Milestones run in letter order; A and B come before a real tenant stores data. Dependencies across them:

```mermaid
flowchart LR
  A1[A1 backups] --> H1[H1 HA decision] --> P3[parked: admin-membership grant]
  C1[C1 CI] --> C5[C5 IaC and environments in CI]
  C4[C4 token scope] --> C5
  F1[F1 paged reads] --> P4[parked: body cache]
  F2[F2 exports in a bucket] --> F3[F3 export retention]
  G1[G1 egress] --> M7[plan 0001 M7 tools]
  G2[G2 request and storage limits] --> M8[plan 0001 M8]
```

## A. Do not lose data

- [x] **A1 Postgres backups** ("Hosting (ADR 0007): no backups"). S, needs Railway access.
  Now: `.railway/railway.ts` declares `postgres-volume` with usage alerts and no backups. The pinned `railway` SDK types
  accept `backupSchedules: ("DAILY" | "WEEKLY" | "MONTHLY")[]` on a volume mount.
  Fix: declare `DAILY` and `WEEKLY`; `make railway-plan` shows it; after `make railway-setup` a second plan is clean. If
  apply does not keep it, set it in the dashboard and name it under "What is NOT here" in the file's header.
  Proof: restore the newest backup outside production and read a known conversation through that environment's api.
  Write the procedure and the measured restore time in docs/deploy.md; drop "no backup" from deploy.md and ADR 0007.
- [x] **A2 Secrets private key copy** ("Secrets private key: lives only as a Railway variable"). S, **human**.
  Copy `SECRETS_PRIVATE_KEYS` from `worker` to a store outside Railway. Prove the copy: `publicKeyOf(copy)`
  (`packages/secrets`) equals `api`'s `SECRETS_PUBLIC_KEY`. Write where it lives (never the value) and the check in
  docs/deploy.md. Do it with A1: a restored database without this key restores no model key.
- [x] **A3 Bucket copy** ("The bucket has no copy outside itself"). M.
  Now: `bucket("kerby")` has no versioning or replication, and message bodies live only there, so A1 alone restores an
  index that points at nothing.
  Fix: use what Railway buckets offer (versioning, replication) if anything; otherwise copy `t/` on a schedule to a second
  S3-compatible store through `packages/blobs`. Message keys carry a content hash, so an incremental copy never overwrites.
  Proof: in a scratch environment delete an object, restore it from the copy, read the conversation.

## B. Isolation and capacity

- [x] **B1 Maintenance and template databases** ("A tenant role can still `connect`"). S.
  Now: `restrictControlDatabase` (`packages/control-plane/src/app-role.ts`) and `ClusterAdmin.restrictDatabase` cover the
  control and tenant databases. `postgres`, `template1` and the tenant template (`kerby_tenant_template`, made by
  `ensureTemplate` without a restriction) still admit `public`. A session held in the template also makes provisioning
  fail: `create database ... template` retries `55006` for 5 s, then throws.
  Fix: at control startup, revoke `connect` from `public` on all three and grant it to `current_user`. A non-owner revoke
  only warns, so the proof is a refused connection, not the statement.
  Proof: a control test where a provisioned tenant role is refused by all three (over the network address, as
  `make multitenant` does); the same check added to `scripts/multitenant.ts`.
- [x] **B2 Turn limit across workers** ("A tenant's concurrent-turn limit is counted per worker process"). M.
  Now: `services/worker/src/service/scheduler.ts:50` subtracts this process's `running` map from `maxConcurrentTurns`.
  Fix: `packages/durable`'s executor claims inside a tenant-database transaction holding `pg_advisory_xact_lock`, counts
  `absurd.r_turns` rows with `state = 'running' and claim_expires_at > now()`, and claims at most the difference (through
  the SDK on the pool's other connection). Keep the local count as a fast path: local at limit means global at limit.
  Proof: two schedulers over one tenant (the `worker.test.ts` pattern), limit 2, five slow turns: never more than two
  running, all five finish. Update ADR 0004's "worker serves many databases" and ARCHITECTURE.md step 1.
- [x] **B3 Connection budget** ("Hosting: Postgres runs with the template's `max_connections`", "The tenant-role
  connection limit ... is a guess", "Connections per api process have no ceiling"). L.
  Now: `ctx.db.listen` opens a new `pg.Client` per call (`packages/db/src/handles.ts:129`), so each event stream holds
  one connection and leases its tenant's pool; `TenantPools` evicts only idle pools, so `maxPools` (50) is soft. Streams
  are capped per tenant per process (`MAX_STREAMS_PER_TENANT`, 20) and nowhere else. Railway's `max_connections` is 100.
  Fix, in order: one `LISTEN` client per tenant database per api process, shared by that tenant's streams; a per-process
  stream cap (`MAX_STREAMS_PER_PROCESS`, 503 when full); the budget formula in docs/deploy.md (processes times pools
  times pool size, plus listeners, control pools and reserved slots); raise `max_connections` (a start option in the IaC
  if the Postgres template takes one, else `ALTER SYSTEM` once per environment, written down); then measure.
  Proof: `make multitenant` with two api replicas and a stream-saturation phase records peak `pg_stat_activity`;
  `TENANT_ROLE_CONNECTION_LIMIT` and `MAX_STREAMS_PER_TENANT` are set from those numbers and logged here.
- [x] **B4 Unknown model provider at `PUT`** ("Model keys (ADR 0008): the api accepts a key for any well-formed provider
  id"). S. Pays the first sentence; the rest is parked below.
  Now: `ModelProviderSchema` checks the format only; `SUPPORTED_PROVIDERS` lives in the adapter, whose `providers.ts`
  imports every Pi provider module.
  Fix: export the id list from a subpath of `@kerby/runtime-pi-durable` that imports no Pi code (a test keeps it equal to
  the provider map); `services/api/src/index.ts` (a composition root may import an adapter) injects it; an unknown id is
  400 `unknown_provider` naming the supported ones. The adapter still owns the list, as ADR 0008 says.
  Proof: api test; `curl -X PUT .../v1/model-keys/nope` on the local stack.

## C. Ship through a gate

- [x] **C1 CI** ("Ephemeral environments are created and deleted by whoever runs", first half; plan 0001 M0). M,
  **human**: create the remote and its secrets.
  Fix: a workflow running `make setup`, `make check`, `make test` on every push and pull request (hosted runners have
  Docker, which `scripts/test-containers.ts` needs); `make e2e` and `make multitenant` nightly. Actions pinned by commit
  SHA (versions live once). Ticks plan 0001 M0.
- [x] **C2 knip** ("`knip` (dead code, unused dependencies) is not wired"). S. Overdue: three services exist.
  Risk: the catalog pins TypeScript 7.0.2, which has no JavaScript API (`createSourceFile` is undefined); confirm the
  chosen knip version runs without it before adopting. Fix: catalog pin and ADR 0005 line, a config naming the entries
  (`services/*/src/index.ts`, package `exports`, `testing.ts`, tests, `scripts/*.ts`, `.railway/railway.ts`), a `knip`
  Makefile target inside `make check`; delete what it finds. If no knip version runs, close the line with that reason.
- [x] **C3 Doc checks** ("No automated doc-freshness pass"). M.
  Fix: `scripts/check-docs.ts` in `make check`: relative links in every `.md` resolve; every `make <target>` the docs name
  exists in the Makefile; every rule a doc calls enforced exists in `check-architecture.ts`. The semantic pass (ADR
  decisions and AGENTS.md invariants against code) runs at each milestone close, and on a CI schedule once C1 exists.
- [x] **C4 Railway token scope** ("Hosting: whoever holds the Railway login can read every secret"). S, **human**: create
  the tokens.
  Measure which commands `scripts/railway.ts` uses (`environment new --duplicate`, `variable set`, `domain`, `up`, `config
  apply`, `environment delete`) succeed under a project token scoped to one environment. Outcome: agents get tokens for
  non-production environments only; production changes go through C5 or a person. Record it in ADR 0007 and deploy.md.
- [x] **C5 IaC and environments in CI** (same line, second half). M. After C1 and C4.
  Fix: `railwayapp/config` plans on pull requests and applies on merge; a pull request gets `ENV=pr-<n>` (setup, deploy,
  a smoke call), deleted with `make env-down` on close.
- [x] **C6 Orphan bucket** ("IaC and buckets: an environment filled in from the file alone"). S. Closed without deleting
  it: `modular-safe-wx5G` has no instance in any environment, so the dashboard does not list it (the owner could not find
  it), `railway bucket delete` refuses ("not deployed in environment"), the public API has no bucket deletion, and an
  environment patch that adds an instance (committed, 2026-11-22) changes nothing. Parked below. The empty-environment
  limitation is an ADR 0007 decision ("verified"); retry an empty environment whenever the `railway` pin is bumped (note
  in `.railway/README.md`).

## D. See failures

- [x] **D1 Queryable logs** ("M3 asks that `make test` run against the real stack"). M.
  Decision: `make test` stays on disposable containers; `make e2e` and `make multitenant` are the real-stack runs (log in
  plan 0001 and tick its M3 item). No traces until a profile needs them.
  Fix: `scripts/logs.ts` (`make logs-query`) reads JSON lines from `docker compose logs`, or from `railway logs` for
  `ENV=<name>`, and filters by `tenantId`, `level`, `msg` and time. Check the Railway CLI's JSON output first.
- [x] **D2 Alerts** ("Hosting: no alarms, dashboard or error alerting"). M, **human**: the destination.
  Fix: Railway notifications for a failed deploy and a crashed service (dashboard; the IaC types have no notification
  setting). In `packages/observability`, `alert(kind, fields)` logs and posts to `ALERT_WEBHOOK_URL` (required outside
  development), debounced per kind, for `turn failed for good`, `lease lost`, a failed provisioning and a failed migration
  fan-out. Tenant ids only, never content. Proof: a test against a local receiver; one alert seen at the destination
  from a scratch environment.
- [x] **D3 Edge and synthetic check** ("Hosting: no edge rate limiting or WAF"). M, **human**: the edge and monitor.
  Fix: the chosen edge in front of a custom api domain, rate limiting there; in `services/api`, a per-address limit on
  failed authentications (the only pre-auth path); an external monitor on `GET /healthz` plus an authenticated read by a
  canary tenant, alerting through D2.

## E. Credentials

- [x] **E1 Per-tenant database credentials** ("Every tenant role's password derives from one shared secret"). L. ADR first.
  Now: `tenantDbPassword` (`packages/control-plane/src/tenants.ts`) is an HMAC of `TENANT_DB_SECRET` and the tenant id,
  used by api, worker and control. That secret alone opens every tenant database.
  Proposal: a random password per tenant, stored in the control plane encrypted with a versioned symmetric key
  (`TENANT_DB_KEYS`, tenant id as authenticated data) held by control, api and worker. Not the ADR 0008 pair: the api
  must open the credential to connect, and must never hold the model-key private key.
  Cutover (expand, then contract): store each tenant's current derived password; deploy api and worker reading the
  stored one; an operator command rotates each tenant to a random password (`alter role`, store, pools evicted on
  `28P01`); delete `TENANT_DB_SECRET`, `tenantDbPassword` and their docs. Proof: rotation test with a live turn; then
  rotate one tenant on a scratch environment.

## F. Bounded data paths

- [x] **F1 Paged reads and a history budget** ("A conversation is capped at 2000 messages", and the paging half of "A
  conversation read fetches every message body"). M.
  Now: `readMessages` (`packages/conversations/src/messages.ts:193`) loads every message, eight S3 gets at a time, for
  `GET` conversation, SSE replay and the worker's rehydrate; the contract has no paging.
  Fix: `GET /v1/conversations/:id?after=<seq>&limit=<n>` (default 100, max 500) returns `nextAfter`; SSE replay reads in
  pages; the worker reads newest-first within `HISTORY_BUDGET_BYTES` using index sizes, never splitting a tool call
  from its result (behavior past the budget: open question). The caps stay; they bound storage, not memory.
  Proof: a 600-message conversation paged in tests and on the local stack; a worker test where the harness sees only the
  newest whole turns. Document in ARCHITECTURE.md step 2.
- [x] **F2 Exports in a bucket** ("Tenant exports are written to the control container's disk"). M.
  Now: `services/control/src/service/export.ts` writes `<name>-<id>-<stamp>.dump` and `.objects.json` under `exportDir`
  and returns those paths.
  Fix: a second bucket that only `control` holds keys for; upload then delete the local file (a single put caps an
  export at 5 GiB: noted); return presigned URLs with an expiry (presigning is a new dependency: catalog pin, ADR 0005
  line; RustFS presigning is untested, spike S3). The export store lives in `packages/blobs` (one door to S3); amend
  ARCHITECTURE.md where it says blobs takes a tenant context on every call. Audit each URL issued.
  Proof: control test against RustFS fetches the URL, and is refused after expiry; one export on a scratch environment.
- [x] **F3 Export retention** ("Deleting a tenant keeps its export files"). S. After F2 and the retention answer.
  Fix: a bucket lifecycle rule if Railway buckets support one; otherwise control deletes expired exports at startup and
  daily. Proof: test with an injected clock.

## G. Before plan 0001 milestones

- [x] **G1 Egress guard** ("Not built: `egress`"; plan 0001 M2). L. Before the first tool (M7) or custom base URL.
  Fix: `packages/egress` on Node built-ins: resolve all addresses and refuse private, loopback, link-local (metadata),
  CGNAT, unique-local and mapped IPv6 ranges with `net.BlockList`; connect to the address that was checked (no second
  lookup, so no DNS rebinding); follow redirects by hand, re-checking each hop, with a hop limit; time and size limits
  on request and response; a `fetch`-shaped function, since MCP and provider clients take one. Tests inject the block
  list so a loopback server can serve the success path. A row in ARCHITECTURE.md#providers.
- [x] **G2 Request rate and storage quota** ("No per-tenant request rate limit and no storage quota"). L. Plan 0001 M8.
  Fix: a per-tenant token bucket in each api process from `limits.requestsPerMinute` (approximate across processes,
  stated in docs); `limits.storageBytes` checked against `sum(size)` of the tenant's `blobs` index in
  `postUserMessage`'s transaction (413 `storage_quota_exceeded`; an admitted turn finishes); stored bytes reported to
  `usage`. Numbers wait for M9 pricing; defaults until then.

## H. Decisions

- [x] **H1 High availability** ("Hosting: one Postgres instance on one volume"). M: an ADR, then its work.
  Options: (a) one instance plus A1 and A3, RTO measured in A1; (b) WAL archiving to a bucket for point-in-time recovery
  (a custom Postgres image and a new tool); (c) a Railway replica, if its Postgres offers one (the SDK types have
  `clusterRole` and `replicaConfig`, unverified for Postgres); (d) managed Postgres elsewhere, an ADR 0007 change that
  likely brings a non-superuser admin. Default: (a) until tenants pay.
- [x] **H2 Sleep** ("Hosting: `api` and `worker` never sleep"). S. Cost only: last.
  Turn `sleepApplication` on for `api` in a scratch environment; measure whether it sleeps with pools and streams, the
  cold start, and an open stream across the threshold. Enable it in the IaC or record the result in ADR 0007. The worker
  stays awake: its scheduler sweeps every 10 s.

## I. Residuals (debts the first release and its reviews left)

- [x] **I1 Backup freshness alarm** ("Bucket backup (ADR 0013)", the clause about a run that never happened). S.
  A fully successful `backupBuckets` run writes an `audit_log` row; control checks at startup and hourly and alerts
  `bucket backup overdue` when the last success is over 26 h old (a process with no record measures from its own start).
  Accepted limit, now in the debt line: control has no public domain, so a control that is down all day alerts only through
  Railway's deployment webhook.
- [x] **I2 Canary read** ("The `uptime` workflow checks `GET /healthz` only"). S, **human** for the secret (done by the
  agent with the owner's login). Production tenant `canary` (1 turn, 60 requests a minute, 1 MiB) with one empty
  conversation and a placeholder Anthropic key (the api refuses a conversation without a model key); the `uptime` workflow
  reads it with `KERBY_CANARY_KEY` and `KERBY_CANARY_CONVERSATION_ID`, and alerts naming the step that failed.
- [x] **I3 Quota race leaves an object** ("A post refused by the quota re-check"). S. `Blobs.delete` (row first, then
  object); `postUserMessage` takes its blob back when the post does not commit. User-post keys carry a per-attempt
  suffix, so a loser of a same-position race can never delete the winner's blob.
- [x] **I4 Export reissue** ("Exports (ADR 0013): a URL lives 24 h"). S. `POST /v1/operator/tenants/:id/export/reissue`
  presigns an existing export (newest, or by stamp), also for a deleted tenant; audited per URL.
- [x] **I5 Worker turn cap** ("A worker has no cap on running turns across tenants"). M. `MAX_RUNNING_TURNS` (default
  50, the `maxPools` default): the scheduler reserves slots before claiming and passes the number to the claim, so it never
  holds a task it cannot run; waiting tenants are served first come first served. Budget formula updated.
- [x] **I6 Railway Monitors and a real webhook event** (the Monitors line). S, **human**. The owner added the Monitors
  in the dashboard (Observability, a widget's menu, Add monitor) and tested them (2026-11-22). They are not in the IaC
  file: its types have no setting for them.

## J. Architecture review (2026-11-23)

An outside review of security, performance and design; each finding checked in code (and measured where it said so).

- [x] **J1 Lookups by id scanned whole tables.** `id::text = $1` on uuid primary keys (blobs, tenants, keys, secrets,
  credentials) matches no index: measured 5.7 ms against 0.02 ms per blob lookup at 100k rows, and a rehydrate looks up
  every message body. Compared as uuid after `isUuid` (`@kerby/db`); rule `queries` refuses the cast.
- [x] **J2 Failed-auth limits outrun by concurrency.** Api and console checked the limit, did the lookup or the hash,
  then counted the failure, so a burst passed. Now lookups (sign-ins) take turns per address, four at once, one at a time
  per console account (`TurnsPerKey`), check the limit when their turn comes and count a failure before giving it up;
  concurrent requests with one credential share one lookup. A first try that held a token per lookup refused 200 good
  keys at once from one address (`make multitenant`'s load run caught it).
- [x] **J3 Unbounded auth cache, unlimited API keys.** The cache kept every credential ever seen; any signed-in person
  could mint keys without end. LRU of 10,000; 50 live keys per tenant.
- [x] **J4 Sign-up capacity.** Each sign-up is a database and a sweep slot; the only limit was per address and process.
  Control's `SIGNUP_BUDGET_PER_HOUR` (30) across all of them.
- [x] **J5 Usage lost on a retried turn.** An attempt that died between persisting an answer and billing it never billed
  it (the harness does not report a persisted message again); a turn now bills what it already holds first.
- [x] **J6 Every sweep visited every tenant.** ADR 0004 said the worker sweeps a bounded set; the code swept all active
  tenants every 10 s, cold-opening a pool per tenant past 50. `tenant_wakeups` hints; full sweep every 5 minutes.
- [x] **J7 `NOTIFY` inside writing transactions.** Such commits serialize across the cluster (9.2k against 20k writes/s,
  measured); a stored message is announced after its commit. Live deltas, already alone, stay on `pg_notify` until a
  trigger (parked "Live events bus").
- [x] **J8 Idle tenant transactions.** A stalled process could hold a claim's advisory lock until TCP gave up; tenant
  sessions now end after 60 s idle in a transaction.
- Recorded, not built: the stored-bytes sums and the bus (parked below), sign-up enumeration and the per-account lockout
  (with "Console accounts"), large tool results in checkpoints and tool idempotency keys (plan 0001, M7).

## Parked behind a trigger

No work until the trigger; the debt line stays and names it.

- **Import scanner** ("The import scanner in `check-architecture.ts` is regex-based"). Trigger: the first false positive.
  Fix then: a pre-pass in `specifiers()` that blanks comments and string contents, no dependency (TypeScript 7.0.2 has
  no JavaScript API), with the false positive as a regression test.
- **Conformance suite** ("`AgentRuntime` has one adapter"). Trigger: a second adapter is proposed. Fix then: lift the
  port-contract cases out of `runtime-pi-durable/src/runtime.test.ts` (event order, persist-before-act gate, rehydration
  without repeating a tool, unanswered tool calls through `executeTool`, refusal) into `@kerby/agent/testing`.
- **Body cache** (the rest of "A conversation read fetches every message body"). Trigger: after F1, a profile shows S3
  gets dominating a read or a rehydrate. Fix then: a per-process LRU of bodies bounded in bytes and keyed by object key;
  keys carry a content hash, so nothing is ever invalidated.
- **Re-seal** (the model-keys line). Trigger: the first secrets key rotation. Fix then: a script run where
  the private keys are (`worker`) that opens each `tenant_secrets` row whose embedded key id is not the current key's,
  re-seals it, and audits it.
- **Console accounts** ("The console (ADR 0014) has open sign-up"). Trigger: the console is advertised, a second console
  process, or the first sign-up abuse. Fix then: an email provider (a dependency and an ADR line) for verification and
  password reset, a CAPTCHA or an edge on sign-up, and the sign-up and sign-in counters shared like the api's; with email,
  sign-up answers the same whether or not the address has an account (the email says which), and a reset link gets an
  owner past a spent per-account limit.
- **Chat gaps** ("The console's chat renders plain text"). Trigger: the first tenant asks. Fix then: a markdown renderer (a
  dependency and an ADR line), `DELETE /v1/conversations/:id` and rename, a title backfill for conversations older than
  `conversations/0003_browsing.sql`, and the first post of a new chat made atomic with its conversation.
- **Alert debounce** ("Alert debounce is per process"). Trigger: a second worker replica. Fix then: share the window in a
  control-database row.
- **CI token scope** ("CI's `RAILWAY_TOKEN`"). Trigger: a second person with write access. Fix then: both secrets behind a
  GitHub environment limited to `main`, no plan on pull requests, or required review.
- **Edge and shared counters** ("No edge proxy or WAF"). Trigger: the owner picks an edge, or `api` runs more than one
  process. Fix then: move the request and failed-auth limits to the edge or a shared counter.
- **Stream connections** ("An open event stream keeps its tenant's pool leased"). Trigger: `MAX_STREAMS_PER_PROCESS`
  reached in production. Fix then: read through a short lease per poll, so only the listener stays open.
- **Bucket copy limits** (the rest of "Bucket backup (ADR 0013)"). Trigger: a tenant is promised an RPO under 24 h, or
  copy volume makes the pass through control costly. Fix then: copy more often, or per-tenant bucket versioning.
- **Orphan bucket** ("IaC and buckets: an orphan bucket"). Trigger: a `railway` pin bump (retry `railway bucket delete -b
  modular-safe-wx5G -e production`), or Railway support offering to delete it. It has no instance, so it holds no data;
  `railway api` lists it in the project (id `d69d20f7-679d-4f10-90cd-d35aec412921`) and the dashboard does not.
- **Stored-bytes total** ("The storage quota sums the tenant's whole blob index"). Trigger: a profile shows `storedBytes`
  in post latency, or a tenant passes 100k blobs. Fix then: a one-row running total in the tenant database kept by
  triggers on `blobs`, `prompts` and `prompt_versions` (contention is bounded by the tenant's concurrent turns), with a
  backfill, read instead of the sums.
- **Live events bus** ("Live events (text deltas, tool events) ride `pg_notify`"). Trigger: waits on the `NOTIFY` lock
  (`object` locks in `pg_stat_activity`) under streaming load, or `api` running more than one process (then the same
  store serves the shared counters of "Edge and shared counters"). Fix then: an ADR for Redis (pub/sub for live events,
  counters with TTLs) behind one package; persisted notices may move too, so the api holds no `LISTEN` on tenant
  databases; a bus that is down costs live deltas only, the 5 s poll still delivers stored messages.
- **Handed to plan 0001**, no work here: stored bytes reported to `usage` (the other half of G2, M8); an operator endpoint
  for tenant limits (M9).

## Log

- 2026-11-22 Plan written. Every tech-debt.md line checked against the code. Corrections made there: `reassignOwned` is
  needed on Railway too; the tenant template database also admits `public`. New lines: no copy of the bucket, no
  per-process connection ceiling (one `LISTEN` connection per event stream).
- 2026-11-22 G1: `packages/egress` (ADR 0010): `createEgressFetch`, a `fetch` that reaches only public addresses (every
  resolved address checked with `net.BlockList`, mapped/NAT64 IPv6 included), connects to the checked address through a
  pinned `lookup`, re-checks every redirect hop (limit 5, no https→http, credentials dropped across origins), one deadline
  and request/response byte limits; any port. Not wired: no caller until plan 0001 M7. PR #2.
- 2026-11-22 Remote `samchristensen/kerby` (private); CI `check` and `test` on every PR and push, `main` protected. The first
  CI run caught a real bug: `serve` lost a stream's abort when the Request was garbage collected (undici links its signal
  through a WeakRef), so SSE streams outlived their clients; fixed, the test forces a GC (PR #1). Parallel `make test`
  runs no longer remove each other's containers (owner pid label, regression test).
- 2026-11-22 C1/ADR 0011 (PR #3): CI builds the three images and pushes `ghcr.io/samchristensen/kerby-<svc>:sha-<commit>`
  on main; Railway services run `kerby-<svc>:<environment>` (IaC `image()`, Railway passes the environment name); release
  on merge moves the tag (`imagetools create`) and `railway redeploy --from-source`, control first; IaC plan on PRs.
  `uptime` (GET /healthz every 15 min) and `nightly` (`make e2e`, `make multitenant`) workflows. Preview environments stay
  manual: a project token cannot create environments.
- 2026-11-22 A1: daily volume backups on production (`railway postgres pitr schedule set --daily`, kept 6 days; the IaC
  export does not show volume attachments and declaring one plans a re-attach, so the schedule lives outside the file).
  Restore drill in a copy environment `drill`: marker row, on-demand backup, second row, restore: back with only the first
  row after 77 s; environment deleted. A2: `SECRETS_PRIVATE_KEYS` copied to the operator's macOS login keychain; the
  copy equals the live value and its public key equals `api`'s `SECRETS_PUBLIC_KEY`.
- 2026-11-22 H1/H2 (ADR 0012): RPO 24 h (nightly), one instance until a tenant pays (then PITR) or an SLA is sold (then
  `railway postgres ha convert`); the admin stays a superuser, so the non-superuser provisioning path goes; nothing
  sleeps. C6: the orphan bucket `modular-safe-wx5G` has no instance in any environment; `railway bucket delete` refuses
  it and an environment patch marking it deleted did not remove it: delete it in the dashboard.
- 2026-11-22 D1+D2 (PR #5): `make logs-query` filters local or Railway JSON logs (Railway's `message`/`timestamp` mapped
  back) by tenant, level, message, service and time. `alert(kind, fields)` logs and posts to `ALERT_WEBHOOK_URL`
  (Slack `{text}`, Discord `{content}`, JSON otherwise; one post per kind per 5 minutes per process; redacted; never
  throws) for turn failed for good, lease lost, provisioning failed, migration fan-out failed; smoke posted provisioning
  and fan-out alerts from a local stack. D2 stays open until a real channel receives one.
- 2026-11-22 A3, F2, F3 (PR #6, ADR 0013): exports upload to a control-only bucket `kerby-exports` (multipart, temp file
  removed) and return 24 h presigned URLs, each audited; retention 30 days at startup and nightly, deleted tenants
  included (Railway buckets have no lifecycle rules); nightly 03:00 UTC copy of `t/` to `kerby-backup` (`sjc`) under an
  advisory lock, changed objects only, deleted tenants' prefixes removed; `POST /v1/operator/backup` and
  `/backup/restore` (missing objects only). RustFS presigning verified (download, 403 after expiry); local smoke deleted
  an object, the read failed, restore brought it back. Production proof waits for the first release.
- 2026-11-22 B4, F1, G2, D3 (PR #7): unknown provider is 400 `unknown_provider` at `PUT` (id list from the adapter's
  Pi-free subpath `@kerby/runtime-pi-durable/providers`); `GET` conversation pages with `after`/`limit`/`nextAfter`
  (default 100, max 500; a breaking change for clients), SSE replays in pages, the worker rehydrates newest-first within
  `HISTORY_BUDGET_BYTES` (8 MiB) cutting before a user message; per-tenant request bucket (600/min per api process, 429
  with `Retry-After`), per-address failed-auth limit (30/min, left-most `X-Forwarded-For` with `TRUST_PROXY` on
  Railway), storage quota (1 GiB, 413). No edge proxy yet (owner); `uptime` is the external check. New debts: usage
  metering of stored bytes, a quota race leaving an object, no endpoint to change limits, no canary read.
- 2026-11-22 C3 (PR #10): `make docs` (scripts/check-docs.ts) in `make check`: relative links in tracked .md resolve,
  named make targets and architecture rule ids exist (`RULES` exported from check-architecture.ts); fixed the one
  finding (C2 named a `knip` target that does not exist yet). The semantic pass stays at milestone close.
- 2026-11-22 B1, E1 paid (PR #8): control closes `postgres`, `template1` and the template to tenant roles; per-tenant
  random database passwords sealed under `TENANT_DB_KEYS` (ADR 0009), with operator rotation, a startup backfill and
  re-seal, and pools that look the password up at every login; `TENANT_DB_SECRET` deleted. Non-superuser admin path
  deleted (H1 keeps Railway's superuser).
- 2026-11-22 B2, B3 paid (PR #11). B2: a claim counts the tenant's running turns (live lease) and claims the difference
  in one tenant-database transaction under an advisory lock; two schedulers, limit 2, five slow turns: peak 2, all
  finish. B3: one `LISTEN` connection per tenant database per process; `MAX_STREAMS_PER_PROCESS` 60 (503
  `server_busy`); budget formula and `max_connections` 500 by `ALTER SYSTEM` in docs/deploy.md#postgres (PgBouncer
  not used: transaction pooling breaks `LISTEN`). Measured (`make multitenant`, two api processes): 3 connections per
  streaming tenant per api process however many streams (46 tenants 156, 60 tenants 181 to 183; bound 190), peak 421 to
  426 in all, one tenant role at most 8; so `MAX_STREAMS_PER_TENANT` 15 (was 20) and `TENANT_ROLE_CONNECTION_LIMIT` 20
  (was 50). Also: a connection lost while a pooled client is checked out no longer crashes the process (regression test).
- 2026-11-22 C2 paid: knip 6.45.1 (parses with oxc, so TypeScript 7's missing JavaScript API does not matter) in
  `make check` as `make knip`, config `knip.jsonc`, ADR 0005 line. Entries: package `exports` (services' `src/index.ts`,
  `./testing`, `./providers`), tests, `scripts/*.ts`, `.railway/railway.ts`, `vitest.config.ts`; entry files' exports
  are checked too. Found no dead files or dependencies, and about 120 exports no workspace imports: unexported or deleted
  (unused contract types and `ErrorResponseSchema`, `taskNames`, service `start*` functions and type re-exports, package
  index re-exports). Kept: the tool-read default exports (config ignore), `EgressError` and the vitest globalSetup
  (`@public` with the reason), `@biomejs/biome` (the Makefile runs it).
- 2026-11-22 Production `max_connections` 100 → 500 (`ALTER SYSTEM`, Postgres restarted, `show max_connections` 500,
  api healthy). TENANT_DB_KEYS created on control before the release (`scripts/railway.ts secrets`).
- 2026-11-22 First release from GHCR (C5). The owner added `RAILWAY_TOKEN` and `GHCR_PULL_TOKEN`; the release for #12
  stopped, as designed, at the IaC deletion of `TENANT_DB_SECRET`. After an on-demand Postgres backup and reviewing the
  plan (image sources, two buckets, ten control variables, `TENANT_DB_KEYS`/`TRUST_PROXY`, three deletions), applied by
  hand with `--confirm-destructive`; the new buckets deployed (objects 0, regions iad and sjc). Re-run of the release:
  registry credentials set, control then api then worker deployed `sha-6c6f33e`; sources are
  `ghcr.io/samchristensen/kerby-<svc>:production`. Production smoke: tenant provisioned, `PUT /v1/model-keys/nope` 400
  `unknown_provider`, a fake Anthropic key stored, a turn ran (worker reached Anthropic: 401 `invalid x-api-key` in
  `lastError`), paged read 200, export 200 and both presigned URLs downloaded (dump starts `PGDMP`; a tampered signature
  403), backup copied 1 object, tenant database password rotated and the read still 200, tenant deleted and its key
  refused (401). `POST /v1/operator/migrate` 200 (new role connection limit).
- 2026-11-22 C4 measured with a throwaway workflow (PR #13, closed): the production project token can run `railway
  status`, list services, read logs, read all 32 control variables (secrets included) and bucket credentials, plan and
  apply the IaC, set registry credentials and redeploy; it cannot create an environment, list projects or answer
  account queries. So agents and CI get project tokens per environment; creating environments stays with the login
  (ADR 0011). The residual risk is a tech-debt line.
- 2026-11-22 D2 wired: the owner made a Slack app with an incoming webhook. `ALERT_WEBHOOK_URL` set on
  control, api and worker (redeployed in order) and as the repository secret the `uptime` workflow posts to; a Railway
  project webhook created through `notificationRuleCreate` (the CLI has no webhook command) for `Deployment.failed`,
  `crashed`, `oom_killed`, preview environments included. Proof: a direct post reached the channel, and `alert()` run
  inside the production control container with its own configuration posted "alert channel check" there. Not done:
  Monitors (dashboard only) and a live Railway event through the rule (`webhookTest` is not authorized for the login):
  a tech-debt line.
- 2026-11-22 I1 to I5 and the canary (this change): backup freshness alarm, canary read in `uptime` (tenant `canary` made
  in production; the key is a repository secret, never printed; a first key was lost to a failed script and revoked), quota
  race cleanup (`Blobs.delete`), export reissue route, worker turn cap. Plan hygiene: questions closed, the paid
  admin-membership entry removed, the debts without a trigger given one or handed to plan 0001. C6 (delete the orphan bucket
  in the dashboard) and I6 (Monitors, Test Webhook) remain: both need the Railway dashboard.
- 2026-11-22 C6 and I6 closed. The orphan bucket is still in the project: the API lists it (no instance), the dashboard does
  not, and the CLI, the API and an environment patch cannot delete it; parked with a retry trigger. The owner added the
  Monitors and tested them. The plan stays in `active/` because the parked items have no other home.
- 2026-11-23 J1 to J8 (an architecture review). Measured first: the blob lookup scan (100k rows), and `NOTIFY` cost with
  `pgbench` on Postgres 18, which disproved the review's first idea (`synchronous_commit = off` for deltas changes
  nothing: a `NOTIFY` alone does not wait for a flush) and found the real cost (a `NOTIFY` inside a write). Redis stays
  out until the "Live events bus" trigger fires (the owner's call).
  Proof on a worktree stack: `make e2e` green (a worker killed mid-turn; the other took the turn when its lease's due time
  came); `make multitenant` green (200 tenants, one turn each in 3.5 s, post to answer p95 907 ms, peak 211 connections);
  60 concurrent requests with one good key on a cold cache all 200; 60 distinct bad keys at once: 30 looked up (401),
  30 refused (429).
