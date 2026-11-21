# 0002. Postgres runs everything; Absurd orchestrates; S3 holds bytes

- Status: proposed
- Date: 2026-11-21
- Replaces for Kerby: lochmoore ADR 0027 (Temporal) and its per-worker SQLite state.

## Context

Lochmoore runs Postgres and Temporal, and pins every chat to one worker because the conversation lives in that
worker's SQLite file. A hosted multi-tenant service wants stateless workers and the fewest moving parts.

## Decision

- **Postgres is the only service.** The control plane and every tenant's database are Postgres
  ([0004](0004-database-per-tenant.md)). [Absurd](https://earendil-works.github.io/absurd/) (durable execution as a SQL
  schema plus a thin TypeScript SDK: tasks, steps, retries, sleep, events) is installed in each tenant database.
  Vendor `absurd.sql` into `packages/durable/migrations/tenant/` as Absurd's docs recommend; pin the release.
- **Background work is an Absurd task**, declared in `packages/durable` (task names, param types, queues), the only
  importer of `absurd-sdk`. Schedules are an idempotent spawn keyed by task and slot (Absurd's cron pattern).
- **Bytes and transcripts live in S3-compatible storage**; the tenant database keeps the index (`blobs`: key, kind,
  size, hash, conversation). `packages/blobs` is the only importer of the S3 client. Object keys are deterministic and
  tenant-prefixed, so a retried write overwrites itself; the index row is written after the object.
- **Local development** runs Postgres, an S3-compatible container (RustFS, Apache-2.0, one container; pinned in
  Compose), `api`, `worker`, and `control`. Production uses any S3.

## Consequences

- Absurd's checkpoints hold small JSON references. Conversation history is never read from them: retention cleanup
  may delete them.
- No built-in cron, concurrency limits, or retention policy: Kerby supplies each (the worker's tenant scheduler for
  limits; plan 0001, M7 for the rest).
- A conversation row and its task are created in one transaction by calling `absurd.spawn_task` on the same
  connection, in the tenant's database (verified: rollback leaves no task). Its `idempotency_key` option makes a repeated spawn return the same task.
- Absurd lets two workers overlap when a lease lapses (verified, lease 2 s, work 6 s: a second worker claimed the task
  after the retry backoff while the first still ran; the first was fenced out at its next step with `FailedTask`).
  A run that heartbeats inside its lease is never reclaimed. So: heartbeat for the whole run, set `fatalOnLeaseTimeout: false`
  (the default kills the whole worker process, every tenant's runs with it), and fence writes that are not Absurd steps
  (ARCHITECTURE.md#durability-the-turn-lifecycle).
- Retention is manual (verified): `absurd.cleanup_all_queues` deletes completed tasks older than the queue's `cleanup_ttl`
  (default 30 days); Kerby schedules it.
- Absurd's docs show 0.x releases: pin exactly and read its changelog on every bump. Upgrades fan out as tenant migrations.

## Rejected

- Temporal: a second cluster to run, secure, and multi-tenant; Kerby uses only what Absurd has.
- pg-boss: queue without step checkpoints.
- Transcripts in Postgres: grows without bound; S3 is cheaper and the index stays small.
