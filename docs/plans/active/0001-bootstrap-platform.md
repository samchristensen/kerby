# 0001. Bootstrap the platform

Goal: a customer can create a conversation over HTTP, get streamed answers, and lose any worker mid-turn without
losing the conversation, while no tenant can reach another's data. Same images locally (Compose) and hosted.
Decisions: ADRs 0001-0004.

## Open questions (block the named milestone)

- Pricing model and billing provider. Blocks M9.
- Hosted deployment target, Postgres hosting (cluster and database limits), and where deploy config lives. Blocks M10.

## Milestones

### M0 Foundation

- [x] Repo scaffold, `make check`, `make test`, git hooks
- [x] `scripts/check-architecture.ts`: workspaces, layers, providers, planes and tenancy, pinned deps (tested)
- [x] `packages/agent`: the `AgentRuntime` / `AgentEvent` port
- [ ] CI runs `make check` and `make test`

### M1 Spikes: each ends with a yes/no and a log line

- [x] S1 Pi Durable on `MemoryStorage`: seeding and continuing work; events map to `AgentEvent`; persist-before-act gating works. Details in ADR 0003 and the log.
- [x] S2 Absurd: in-transaction spawn, idempotency, lease and heartbeat, retention all verified. Details in ADR 0002 and the log.
- [x] S3 Local S3 container: RustFS chosen. Put, overwrite, get, head, list, prefix delete, 20 MB put and `If-None-Match` all pass; SeaweedFS also passes (1 GB image, 2 s first put); `minio/minio` could not be pulled from Docker Hub; Garage was not tried (needs a layout step).
- [x] S4 Absurd across many databases: yes, on-demand claim works. Numbers in the log.
- [x] S5 Pools for many tenant databases: an LRU of small pools works; no pgbouncer at this scale. Numbers in the log.

### M2 Packages (each: one purpose, tests, a row in ARCHITECTURE.md#providers if it wraps a system)

- [x] `config` (`loadConfig`, check `config`), `observability` (tenant id on every log line)
- [x] `db`: `ControlDb`, `TenantDb`, tenant pool registry, migrator for both planes
- [x] `durable`: task names and params, spawn, register, vendored `absurd.sql`, tenant claim loop, lease heartbeat for a whole run, `fatalOnLeaseTimeout: false`, `cleanup` (the daily schedule is M8)
- [x] `blobs`: `put`/`get` taking a tenant context, writing the tenant's index
- [x] `contracts`: HTTP schemas; the persisted event envelope
- [ ] `secrets`: envelope encryption with a per-tenant data key (KMS behind it)
- [ ] `egress`: outbound guard for tenant-supplied URLs (private ranges, DNS rebinding, redirects, size and time limits)
- [x] `runtime-pi-durable`: adapter (seed via `appendEntry`, sentinel continue plus `beforeRequest` filter, drop `system` entries, resolve unanswered tool calls first, `native` passthrough, tool `callId` as the executeTool key); passes the conformance cases it can

### M3 Local stack

- [ ] `compose.yaml`: Postgres, S3 container, control, api, worker. No published host ports; per-worktree isolation.
- [ ] `make up` provisions a `default` tenant and prints its API key; `make down-v` leaves nothing behind
- [ ] `make test` runs against the real stack; logs and traces an agent can query

### M4 Control plane (`services/control`)

- [x] `tenants`, hashed `api_keys` (prefix id, rotation, last used), operator API
- [x] Provision (database, scoped role, tenant migrations, Absurd queues, first key), suspend, export, delete; each tested end to end
- [x] Migration fan-out with `tenants.schema_version`; code tolerant of n and n-1 (fan-out done, tolerance is a review rule)

### M5 Turn pipeline (one tenant)

- [ ] api: verify key, create conversation, post message (row plus spawn), read, stream events (SSE)
- [ ] worker: tenant scheduler, `run-turn` task: rehydrate, run, supervise, persist each `message_end` (object, index row, step)
- [ ] Kill a worker mid-turn: the turn finishes elsewhere, no duplicate tool effect (test)
- [ ] Fencing test: let a lease lapse mid-run, a second worker continues, the first cannot insert a divergent message (the index insert is guarded by `last_attempt_run` under a row lock)

### M6 Multi-tenant proof

- [ ] Second tenant; a cross-tenant suite: key A cannot read or write B's conversations, blobs, or tasks; a swapped tenant context fails
- [ ] Fair scheduling: a noisy tenant at its limit does not delay another (test); N-tenant load run against S4/S5 numbers
- [ ] Suspended tenant is refused within the auth cache TTL

### M7 Tools

- [ ] Per-tenant tool registry (MCP URL plus auth) with credentials in `secrets`; every call through `egress`
- [ ] `executeTool` as a keyed step; the interrupted-write rule from lochmoore

### M8 Limits and operations

- [ ] Per-tenant concurrency and rate limits; usage rows to the control plane from assistant-message usage
- [ ] Scheduler (idempotent spawn); Absurd retention cleanup; S3 orphan sweep; per-tenant metrics

### M9 Commercial readiness

- [ ] Plans and limits as data; billing integration; usage visible to the tenant
- [ ] Tenant console: keys, tools, model keys (BYO), usage
- [ ] Audit log, including operator access to a tenant; verified export and deletion; optional per-tenant bucket and KMS key
- [ ] Not code, but required before selling: terms, DPA, security posture page, incident process

### M10 Consumers

- [ ] Images published; consumer `compose.yaml`; `@kerby/sdk` and CLI ported from lochmoore
- [ ] Lochmoore calls Kerby as its first tenant

## Log

- 2026-11-21 M0 scaffold, checker and the agent port written; ADRs 0001-0003 proposed.
- 2026-11-21 Tenancy redesigned for untrusted customers: ADR 0004 (database per tenant, control plane), ADR 0001 rewritten, checker enforces migration planes.
- 2026-11-21 Spikes S2 (partial), S4, S5 run against Postgres 17 in Docker (absurd-sdk 0.5.1, pg 8.23.1, one local container, no TLS or network latency). `absurd.spawn_task` joins the caller's transaction (rollback leaves no task; commit creates it) and its idempotency key returns the same task with `created=false`. The SDK has `claimTasks` and `workBatch`, so the worker can claim on demand per tenant. 1000 databases provisioned from a template database holding `absurd.sql` and a queue: 22 ms each. Sweeping 1000 tenants with one `claimTasks` each: 3.9 s at concurrency 20 (39 s sequentially, mostly cold connection opens), peaking at 282 connections and +60 MB RSS; idle pools release every connection. LRU of 50 pools across 1000 databases: cold open 5.7 ms, warm 0.0 ms, 50 connections, 200 tenants at once in 95 ms. Not measured: Postgres backend memory, cross-host latency, 10k tenants. Design consequence: the worker claims only for tenants hinted by `NOTIFY`, and the periodic sweep runs at concurrency about 20 over a bounded set, not every tenant continuously.
- 2026-11-21 Spike S1 (pi-durable 1.4.0, faux provider): `root.commit` with `appendEntry` seeds a memory-backed conversation with user, assistant-with-tool-call and tool-result entries and the model sees exactly that history. Nothing auto-continues after seeding (including `resume()`), and a seeded tool call with no result gets the placeholder "Tool result unavailable". Continuing without a new user message works by submitting a sentinel input and removing it in a `GenerationTask` `beforeRequest` hook: the model then sees history ending at the tool result. `watchEvents` yields `message_start`/`message_end` (message in `entry.model[0]`, including the sentinel user and Pi's `system` entries, both to be dropped), `tool_execution_*`, `turn_*`, `run_*`, `usage_changed`; the snapshot is not replayed. A pull-based async generator over those events, with each tool's `execute` awaiting a gate released only after the consumer has pulled past the assistant's `message_end`, ran the tool 0 ms after the slow (150 ms) persist: persist-before-act holds. `api.callId` is exposed to tools. Pi messages carry more than the neutral type, so `AgentMessage` gained an opaque `native` field.
- 2026-11-21 Spike S2 rest (Absurd 0.5.1): lease 2 s, work 6 s, no heartbeat: the run is failed and rescheduled, a second worker claims it after the retry backoff (3.0 s) and both run concurrently; the first worker's next `ctx.step` throws `FailedTask: Task already failed`. Heartbeating every 1 s: no second claim, one attempt. So work outside steps can overlap, which is why the index insert is fenced. `cleanup_all_queues('turns')` deleted a completed task past the queue's `cleanup_ttl` (default 30 days); it runs only when called. Design consequences recorded in ADR 0002 and ARCHITECTURE.md.
- 2026-11-21 Spike S3: RustFS (latest, Apache-2.0) and SeaweedFS (latest) both pass every operation Kerby uses through `@aws-sdk/client-s3` with path-style addressing; both reject a second `If-None-Match: *` put with 412. Not tested: Garage, multi-part uploads over the SDK's threshold, presigned URLs.
- 2026-11-21 T0: `vitest.config.ts` plus `scripts/test-containers.ts` start `postgres:17-alpine` and `rustfs/rustfs:1.0.6` (random host ports, label `kerby-test=1`, stale ones removed at start) and `provide` them as `inject("containers")`; run takes about 2 s with images cached. Decision: `createTestControlDb`/`createTestTenant` live in `@kerby/db/testing` (T3), and take migration directories as arguments because a package may not import a service's migrations.
- 2026-11-21 T1: `@kerby/config` `loadConfig(schema, sources?)` (file < env < secrets dir; unknown file keys fail; errors name keys, never values) and the `config` architecture rule (process environment read only in `packages/config` and `scripts`). ADR 0005 is the running list of dependency reasons; `zod` 4.6.7 added.
- 2026-11-21 T2: `@kerby/observability` `log(level, msg, fields)`, `withTenant` (AsyncLocalStorage), `errorFields`. Decision: a line outside `withTenant` carries `tenantId: null` (system work) rather than being refused; content-carrying keys (`content`, `text`, `body`, `prompt`, secrets, `tenantId`) are type errors and are dropped at runtime and named in `redacted`; non-scalar values are dropped the same way.
- 2026-11-21 T3: `@kerby/db` (`ControlDb`/`TenantDb` branded handles with `query`/`transaction`, `createControlDb`, `createTenantDb`, `TenantPools` LRU that evicts only idle pools, `migrate` under an advisory lock recording `<workspace>/<file>`, `migrateTenants` at concurrency 20, `@kerby/db/testing`). Decision (ADR 0006, proposed): control migrations and queries live in `packages/control-plane`, not `services/control`, because api, worker and control all read those tables and services may not import each other; likewise conversation tables will live in `packages/conversations`. `createTestControlDb` is `@kerby/control-plane/testing`; `createTestTenant` will be `@kerby/conversations/testing` (T9 prerequisites). Tenant DB role passwords will be derived (HMAC of a master secret and the tenant id), not stored, because `packages/secrets` is outside T0-T13.
- 2026-11-21 T4: `@kerby/durable`: `0001_absurd.sql` vendored from absurd tag 0.5.1 (commit 201a1ef), `0002_queues.sql` (`turns`, `system`), `TASKS`/`TaskParams`, `spawnInTx` (SQL `absurd.spawn_task` on the caller's tx; default 5 attempts, exponential retry), `createTenantExecutor` (`claim`, `execute` with heartbeat every claimTimeout/3 and `fatalOnLeaseTimeout: false`), `holdsRun` (task row `for share`, `last_attempt_run` and state `running`), `cleanup`. Tests (real Postgres): rollback leaves no task, idempotent spawn, 4.5 s run with a 2 s lease is never claimed twice, a lapsed lease fences the first run (its guarded insert is refused, the second run's lands). `RunContext.step` hides Absurd's `TaskContext`; the runId reaches handlers through AsyncLocalStorage set around `executeTask`.
- 2026-11-21 T5: `@kerby/blobs` (`createBlobs`: `put`, `get`, `deletePrefix`, `ensureBucket`; `0001_blobs.sql` index with the full `object_key`; `TenantContext = { tenantId, db }` added to `@kerby/db`). `get` looks the id up in the caller's own index and also refuses a row whose key is outside `t/<ctx.tenantId>/`, so a swapped context fails. Keys are validated (no `..`, `.`, empty segments); `@kerby/db/testing` gained `createMigratedDatabase(dirs)` (cached template per process), now used by control-plane and durable tests. `@aws-sdk/client-s3` pinned 3.1169.0 (8 days old; 3.1175.0 is newest).
- 2026-11-21 T6: `@kerby/contracts`: zod schemas for the agent port types (compile-time equality with `@kerby/agent` via `expectTypeOf`), the tenant API (create conversation, post message `{content: string | parts}`, get conversation with `busy`, SSE `EventEnvelope`; `native` is stripped from public messages) and the operator API (tenant, key, export). Decision: the export response is a dump file name in the control service's export directory plus the object prefix and count, not a download.
- 2026-11-21 T7: `@kerby/runtime-pi-durable` `createPiDurableRuntime({ models, resolveModel?, modelRetry?, onReport? })` (pins pi-durable, pi-ai, chord 1.4.0, the spike's versions). New in-memory harness per run seeded by `appendEntry`; unresolved tool calls in history go through `executeTool` first and are reported as events; sentinel input plus `beforeRequest` filter; tool `execute` waits at a per-call gate opened after the consumer pulled past the assistant `message_end` (mutation-checked: disabling the gate fails the slow-consumer test); after Pi settles, entries are re-read and any assistant or tool message the event stream did not deliver is reported (the stream is a view, entries are truth); 4xx other than 408/409/429, and an unknown model, end as `run_end refused`, other failures throw; error and aborted assistant messages are never reported as messages. Decision: tool messages persist Kerby's own `executeTool` content (blob refs), assistant messages carry the full Pi message in `native`. Pi emits `message_start` for failed attempts without a `message_end`: supervisors must tolerate that.
- 2026-11-21 T8: `@kerby/serve` (router, `HttpError`, `readJson`, streaming-safe `node:http` server with a per-request abort signal) and `services/control` (operator API behind `OPERATOR_TOKEN`; provision, suspend/resume, rotate/create/revoke keys, export, delete, `POST /v1/operator/migrate`). Supporting packages: `@kerby/control-plane` (tenant and key queries, `kb_<id>_<secret>` keys hashed with SHA-256 and compared in constant time, audit), `@kerby/conversations` (tenant tables, `tenantMigrationDirs`, `createTestTenant`), `ClusterAdmin` and `dumpDatabase` in `@kerby/db`, `listPrefix` in blobs, `childProcessEnv` in config. Decisions: tenant database and role names derive from the tenant id; the role password is an HMAC of `TENANT_DB_SECRET` and the id (no stored credential; `packages/secrets` is outside T0-T13); the role owns its database (objects are re-owned by hand after the template copy because a superuser cannot REASSIGN OWNED); a deleted tenant keeps its row but frees its name (partial unique index); `provisioning` is a tenant status and a failed provision removes the database, role and row. Smoked against a real Postgres 17 and RustFS: provision created `t_<id>`, delete left no database or role.
