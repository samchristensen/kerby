# 0002. Autonomous build runbook (M2 to M6)

For the agent building Kerby with no human present. Read this first after any context reset, then
`AGENTS.md`, `ARCHITECTURE.md`, ADRs 0001-0004, and plan 0001 (milestones and the spike log hold the facts you need).

## Operating rules

- Do not ask questions. Decide, write the decision as one line in plan 0001's Log, continue. A choice with real
  tradeoffs and no clear default gets an ADR (status proposed) and the boring option.
- One task = one commit that passes `make check` and `make test`. Commit messages: imperative, under 72 chars.
  Step 0 below creates the first commit. Work on `main`; never force-push; never push anywhere.
- Update docs in the same commit (ARCHITECTURE.md#providers row, plan ticks, ADR lines). Add a dated Log line per task.
- A new dependency: catalog line (exact pin, at least 7 days old, `pnpm view <pkg> time`), ADR line, `pnpm install`.
- If a check fails, fix the code. Never edit `scripts/check-architecture.ts` to pass. Changing a rule is an ADR.
- Stuck on one task for three attempts: write what failed under "Blocked" at the bottom of this file, skip to the next
  independent task. Never leave `main` red.
- Verify by running: every task ends with a smoke run of the changed path against real Postgres and RustFS.
- Stop when M6 is ticked or every remaining task is Blocked. Final message: what is done, what is blocked, what you assumed.

## Step 0: once

1. `git add -A && git commit -m "Scaffold Kerby: checks, agent port, docs"` (hook runs `make check`; `make setup` first).
2. Create `docs/plans/done/` only when a plan completes.

## Test infrastructure (build first, task T0)

- `vitest.config.ts` with a `globalSetup` that starts disposable containers via `docker run` and exports their URLs to
  tests through `provide`/env: `postgres:17-alpine` (`-c max_connections=500`, random host port, `POSTGRES_PASSWORD=dev`)
  and a pinned `rustfs/rustfs` (env `RUSTFS_ACCESS_KEY=devkey`, `RUSTFS_SECRET_KEY=devsecret123`, command `/data`, port 9000).
  Tear both down after the run. Wait for readiness (`pg_isready` via a `pg` connect loop; an S3 `ListBuckets` loop).
- Test helpers (in the owning package's `src/testing.ts`, exported as `@kerby/<pkg>/testing`): `createTestControlDb()`
  (fresh database from the control migrations) and `createTestTenant()` (database from a template that already holds the tenant
  migrations, 22 ms each as measured; bucket prefix unique per test).
- Raise `make test` timeout expectations: container start is about 5 s.

## Facts proven by spikes (do not re-derive)

- **Absurd** (`absurd-sdk` 0.5.1, `pg` 8.23.1; docs https://earendil-works.github.io/absurd/). Schema file:
  `https://raw.githubusercontent.com/earendil-works/absurd/main/sql/absurd.sql`; vendor it as
  `packages/durable/migrations/tenant/0001_absurd.sql` and record the source commit in a leading SQL comment. Then
  `select absurd.create_queue('<name>')` (queues: `turns`, `system`). Client: `new Absurd({ db: pool, queueName, log })`.
  `registerTask({name}, async (params, ctx) => ...)`, `spawn(name, params, { idempotencyKey, maxAttempts, retryStrategy, headers })`,
  `claimTasks({ workerId, claimTimeout, batchSize })`, `executeTask(task, claimTimeout, { fatalOnLeaseTimeout: false })`,
  `workBatch`, `ctx.step(name, fn)`, `ctx.heartbeat(seconds)`, `ctx.beginStep/completeStep`. In SQL:
  `absurd.spawn_task(queue, name, params jsonb, options jsonb)` returns `(task_id, run_id, attempt, created)` and joins the caller's
  transaction; options key `idempotency_key`. Task tables are `absurd.t_<queue>` (`state`, `attempts`, `last_attempt_run`, `enqueue_at`).
- A lease lapse lets a second worker start while the first still runs; the first fails at its next step (`FailedTask`). Heartbeat
  for the whole run (every claimTimeout/3). Fence non-step writes with `last_attempt_run` under `for share` on the task row.
- `absurd.cleanup_all_queues('<queue>')` honors `absurd.queues.cleanup_ttl` (default 30 days); schedule it daily per tenant.
- **Provisioning**: create a template database holding the tenant migrations, then `create database t_<id> template <tpl>`.
  Per-tenant role: `create role` with `connect` on that database only; revoke `public` connect.
- **Pools**: LRU of `pg.Pool({ max: 2, idleTimeoutMillis })`, cap 50; cold open 5.7 ms. Sweep concurrency about 20.
- **Pi Durable 1.4.0** (`@earendil-works/pi-durable`, `pi-ai`, `chord`, all pinned together; Node 26 ok):
  `Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT)`; `harness.root(ctx, { agent: { model: { provider, modelId } } })`.
  Seed: `root.commit(async tx => tx.appendEntry(UserEntry | AssistantEntry | ToolResultEntry, root.id, { model: [msg], data? }), ctx)`
  (`ToolResultEntry` needs `data: { diagnostics: [] }`). Continue: `root.submit({ type: "input", content: SENTINEL }, ctx)` plus
  `hook(GenerationTask, { beforeRequest: req => ({ messages: req.messages.filter(m => !isSentinel(m)) }) })` in an installed
  extension. Events: `watchEvents(harness, root.id, ctx)` then `stream.start(async events => ...)`; `message_end` carries
  `entry.model[0]`; drop the sentinel user message and `system` entries. Tools: `defineTool({ name, description, parameters: Type.Object(...), execute: async (args, api) => ({ output: [{ type: "text", text }] }) })`
  with `Type` from `@earendil-works/pi-ai`; `api.callId` is the tool-call id. Tests use `fauxProvider`/`fauxAssistantMessage`/`fauxToolCall`
  from `@earendil-works/pi-ai/providers/faux`; never a real model key in tests.
  Gate each tool's `execute` on a promise released after the consumer pulled past the assistant `message_end` that holds the call.
- **S3**: `@aws-sdk/client-s3`, `forcePathStyle: true`, region `us-east-1`; RustFS passes put, overwrite, get, head, list, `DeleteObjects`, 20 MB put,
  `IfNoneMatch: "*"` (412 on conflict).

## Tasks (in order; tick in plan 0001 as well)

Each task lists what to build and its acceptance. Tests are behavioral; use the real containers.

- [x] **T0** Test infrastructure above. Acceptance: a trivial test per helper passes; `make test` leaves no containers behind.
- [x] **T1 `packages/config`**: `loadConfig(schema)` with zod (add `zod` to the catalog): YAML file < env < secrets dir; fails naming keys, never values.
  Add a check (rule id `config`) that `process.env` appears only in `packages/config/src` (and scripts). Test the check and the loader.
- [x] **T2 `packages/observability`**: `log(level, msg, fields)` JSON to stdout, `tenantId` field required via a `withTenant(tenantId, fn)` AsyncLocalStorage helper; never logs message content (no free-form `content` field). Biome `noConsole` already forbids console.
- [x] **T3 `packages/db`**: `ControlDb`, `TenantDb` (branded wrappers exposing `query` and `transaction`), `createControlDb(url)`, `TenantPools` (LRU, injected resolver `(tenantId) => Promise<url>`), `migrate(db, dir)` recording applied files in `schema_migrations`, `migrateTenants` fan-out helper (concurrency 20). Only importer of `pg`. Control migrations (in `services/control/migrations/control/`): `tenants` (`-- global`), `api_keys`, `usage`, `audit_log`, `tenant_secrets`.
  Acceptance: a `TenantDb` for tenant A cannot see tenant B's tables (separate databases); passing a `ControlDb` where `TenantDb` is required is a type error (`// @ts-expect-error` test).
- [x] **T4 `packages/durable`**: vendored `absurd.sql`; `taskNames` and param types; `spawnInTx(tx, queue, name, params, idempotencyKey)` using the SQL function; `registerTasks`; `claimLoop` helpers (claim for one tenant, bounded concurrency, heartbeat timer, `fatalOnLeaseTimeout: false`); `cleanup(tenantDb)`. Only importer of `absurd-sdk`.
  Acceptance: tests for spawn-in-tx rollback, idempotency, heartbeat prevents a second claim, lease lapse fences the first run.
- [x] **T5 `packages/blobs`**: `createBlobs({ endpoint, bucket, credentials })`; `put(tenantCtx, { kind, key, body, mediaType })` writes `t/<tenantId>/<key>` then the tenant's `blobs` index row (tenant migration); `get(tenantCtx, blobId)` checks the index first; `deletePrefix(tenantId)`. Only importer of the S3 client.
  Acceptance: tenant A's context cannot read tenant B's blob id; retried put overwrites and keeps one index row.
- [x] **T6 `packages/contracts`**: zod schemas for the HTTP API (create conversation, post message, get conversation, SSE event envelope `{ v:1, conversationId, runId, seq, at, event: AgentEvent }`), operator API (create tenant, create/rotate key, suspend, delete, export).
- [x] **T7 `packages/runtime-pi-durable`**: `AgentRuntime` per ADR 0003 and the spike facts: new harness per run, seed history, resolve unanswered tool calls through `executeTool`, sentinel continue, event mapping, tool gating, `native` passthrough, usage mapping, refusal (HTTP 4xx other than 408/409/429) to `run_end` `refused`.
  Acceptance (faux provider): text-only run; tool run calls `executeTool` once; a run rehydrated from history after a "crash" (new runtime, same history) finishes without repeating the persisted tool call; events arrive in order and `message_end` is persisted before the tool executes (slow-consumer test).
- [x] **T8 `services/control`**: HTTP (`@kerby/serve`-style small `node:http` fetch handler in `packages/serve`, add it) operator API behind `OPERATOR_TOKEN`; provision (template copy, role, queues, first key), suspend, rotate key, export (`pg_dump` via child process plus object prefix listing), delete. Layers per ARCHITECTURE.md. Acceptance: provision then delete leaves no database, role, or objects.
- [ ] **T9 `services/api`**: auth middleware (key prefix id lookup, constant-time hash compare, 30 s cache, suspended refused) to a tenant context; routes `POST /v1/conversations`, `POST /v1/conversations/:id/messages` (one tx: insert user message row, `spawnInTx` with idempotency key `turn:<conversationId>:<seq>`, then `NOTIFY tenant_work` on the control DB), `GET /v1/conversations/:id`, `GET /v1/conversations/:id/events` (SSE: replay from the index after `Last-Event-ID`, then tail with Postgres `LISTEN` on the tenant DB). `/healthz`. Tenant migrations in `services/api/migrations/tenant/` (`conversations`, `messages`, `blobs` lives in `blobs`).
- [ ] **T10 `services/worker`**: tenant scheduler (LISTEN `tenant_work` on control, bounded sweep, per-tenant concurrency from the tenant's limits), `run-turn` task per ADR 0003 and ARCHITECTURE.md#durability: rehydrate, run via `AgentRuntime`, supervisor persists each `message_end` (blob, fenced index insert, step), heartbeat, usage rows to the control plane, live deltas via `NOTIFY`. `executeTool` as an Absurd step keyed by conversation and tool-call id; start with a built-in `echo` tool and the tenant tool registry stub returning no tools (real registry is M7).
- [ ] **T11 Local stack**: Dockerfiles (`dev` and `prod` targets, node image from `.node-version`, run as non-root, `HEALTHCHECK`), `compose.yaml` (Postgres, RustFS, control, api, worker; named volumes; no published host ports except what `make up` needs: publish `api` on a documented host port because there is no shared proxy here), `make up` (provision `default` tenant, print its key), `make down`, `make down-v`, `make psql`. Check: add a rule that every `services/*` has a Dockerfile with `HEALTHCHECK`.
- [ ] **T12 End-to-end** (M5 acceptance): with the stack up and a faux model (env `KERBY_FAKE_MODEL=1`, honored only when set; production config rejects it), create a conversation, stream the answer with `curl`; kill the worker mid-turn (`docker kill`) and see the turn finish on a second worker with no duplicate tool effect; fencing test from plan 0001.
- [ ] **T13 Multi-tenant proof** (M6): second tenant, cross-tenant attempt suite (conversations, blobs, tasks, SSE, key reuse), suspension within the cache TTL, fair scheduling test (a tenant at its limit does not delay another), a 200-tenant load run recorded in the Log.

## After T13

Tick M2 to M6 in plan 0001, move nothing, and stop. M7 onward needs product decisions (tool auth, pricing) and a human.

## Blocked

(none yet)
