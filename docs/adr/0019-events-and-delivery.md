# 0019. Events: an outbox in each tenant database, pulled or pushed through one dispatcher

- Status: proposed
- Date: 2026-11-23

## Context

Customers could only pull: a per-conversation SSE stream, paged reads with `busy`, and `GET /v1/judgments/:id`. Nothing
told a customer's backend that a turn had finished; worse, "finished" was not even recorded: `run_end` was a live
`NOTIFY`, and two exit paths (a guardrail that could not be checked, a turn that failed for good) sent none, so a stream
waited forever. Customers want different things: a webhook when a turn is done, one per message, a queue to poll, or
nothing at all. They want it per integration (ADR 0020), and safely, because tenants are untrusted and their endpoints
are on the internet.

## Decision

- **The outbox is a table in each tenant database** (`events`, `packages/events`), written in the same transaction as
  the change it describes: the user message (`postUserMessage`), each persisted message (`persistMessage`, fenced, so a
  run that lost its lease cannot emit one), the conversation row, a turn's outcome, a judgment's outcome. No broker:
  Postgres is the only service (ADR 0002). Every row has a `dedupe_key`, so a retried step records its event once.
- **Durable events only.** `conversation.created`, `message.created`, `turn.started`, `turn.completed`, `turn.blocked`,
  `turn.failed`, `judgment.completed`, `judgment.failed` ([contracts](../../packages/contracts/src/events.ts)). Token
  deltas stay on the conversation's SSE stream: one POST per token is a flood, and a delta is never needed to resume.
- **Thin payloads.** An event carries ids, sequence numbers, status and a scrubbed failure reason; never message
  content. The customer reads content with the API it already has. One body serves every subscriber, a compromised
  endpoint learns little, and an event's version stays stable.
- **Every turn ends with exactly one outcome event** (`turn:<conversation>:<seq>:outcome`): completed, blocked, or
  failed (`no_model_key`, `guardrail_unavailable`, `refused`, `error` after the last attempt), written fenced by the run
  that still holds the task. The conversation stream also gets a live `run_end` on every path: `refused` when Kerby will
  give the same answer again, and a new reason `failed` (sent by the supervisor only) when the last attempt failed.
- **A cursor that never skips.** Identity values are taken in insert order but become visible in commit order, so a
  reader that has seen id 11 can miss id 10 committing later. Each row stores its transaction id
  (`tx xid8 default pg_current_xact_id()`); a reader returns only rows with `tx < pg_snapshot_xmin(pg_current_snapshot())`
  (every transaction below it has finished), ordered by `(tx, position)`. A cursor is `<tx>.<position>`; a read that
  returns fewer rows than asked advances it to `<xmin>.0`, so a filter that matches nothing still moves on. The poll
  endpoint and the dispatcher's fan-out use the same function.
- **Pull: `GET /v1/events`** (`after`, `limit` up to 500, `types` with `turn.*` wildcards, `conversationId`, `wait` up to
  30 s of long-poll on a `LISTEN events`, which the writer notifies after its commit, re-reading every second). It counts
  against the same per-tenant and per-process caps as SSE streams. Needs the `events` scope; what it returns depends on
  visibility (ADR 0020).
- **Push: subscriptions.** A subscription belongs to an integration and names a destination, event type patterns and a
  scope (`own`: what that integration started; `tenant`: everything, which needs the integration's `tenant` scope). The
  row lives in the control database (it is configuration, like keys and model keys, and the dispatcher must find
  subscribed tenants with one query); its cursor and the delivery log live in the tenant database, so fan-out is one
  tenant transaction: read events after the cursor, spawn `deliver-events` tasks on a new Absurd queue `deliveries`
  (idempotency `deliver:<subscription>:<first event>`), advance the cursor. A new subscription starts at "now". A
  deleted subscription is a tombstone (`state = 'deleted'`, read by nothing) until a dispatcher has cancelled its queued
  deliveries and dropped its cursor in the tenant database, which the console, deleting an integration, cannot reach;
  then the row goes. The dispatcher skips a tenant with no subscription row at all, so every tenant's events cost it one
  control query, not a tenant database.
- **A destination port, `packages/delivery`, types only** ([source](../../packages/delivery/src/index.ts)), as
  `packages/agent` and `packages/judgment` are: a `Destination` declares `maxBatch`, makes a secret (`newSecret`), checks
  a config (`check`), and delivers a batch of serialized events (`deliver`) to an outcome: `delivered`, `failed` (retry)
  or `gone` (stop for good). One adapter per kind, `packages/delivery-<kind>`; only a service's `src/index.ts` imports
  one (enforced). The config shapes are a union in `packages/contracts`. Adding a kind is a contract entry, an adapter
  package and a registry line in api and dispatcher. Principle 2 (rule of three) yields to a port here, as it does for
  harnesses and judgments.
- **The first kind is `webhook`** (`packages/delivery-webhook`), signed by [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
  v1: `webhook-id` (the event id, stable across retries: the dedupe key), `webhook-timestamp` (per attempt),
  `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, secrets `whsec_<base64 of 32 bytes>`. After a
  rotation both secrets sign for 24 hours (space-separated signatures). `node:crypto` only; receivers verify with any
  Standard Webhooks library. One event per POST, 10 s, redirects refused, at most 1 KiB of the response kept for the
  delivery log, every request through `packages/egress` (ADR 0010). Plain http and private addresses only with
  `ALLOW_LOCAL_DESTINATIONS` in development. 2xx is delivered, 410 is gone, anything else is a retry.
- **A new service, `services/dispatcher`**, so slow customer endpoints never hold turn slots and only one process holds
  the key that opens signing secrets. It is the worker's scheduler shape: `LISTEN tenant_events` on the control database
  (the api and worker `NOTIFY` after committing an event), a sweep of tenants with subscriptions every few seconds, a
  per-tenant cap (`limits.concurrentDeliveries`, default 4) and a process cap (`MAX_RUNNING_DELIVERIES`, default 50),
  longest-waiting tenant first. A delivery retries 20 times, exponentially from 30 s up to 6 h between attempts (about
  two and a half days); delivery is at least once and unordered (events carry `seq`). A subscription failing for 48
  hours, or answered 410, is disabled; re-enabling resumes from its cursor, so no event in retention is skipped.
- **Retention is 30 days**, like Absurd's and exports': control's nightly job deletes older events and delivery
  attempts in every tenant database, and runs Absurd's cleanup there too (it was never scheduled before).
- **Signing secrets are sealed to a key pair of their own** (`packages/secrets`, as in ADR 0008): the api holds
  `DELIVERY_SECRETS_PUBLIC_KEY` and seals a new secret it shows once; only the dispatcher holds
  `DELIVERY_SECRETS_PRIVATE_KEYS`. The worker's key pair, which opens model keys, is not reused.
- **Managing subscriptions is an admin act**: `/v1/subscriptions` (create, list, get, update, delete, rotate the secret,
  send a test `ping`, read the delivery log, redeliver an event) needs the `admin` scope or a console session, and each
  change is an audit row. A leaked key without `admin` cannot point events somewhere else.

## Consequences

- One more deployable, image and Railway service; the dispatcher's connections join the budget in docs/deploy.md.
- The xmin horizon is cluster-wide: a long write transaction in any database on the cluster delays visibility of new
  events everywhere by its length. Kerby's transactions are short; a migration or a manual session left open shows up as
  event latency, never as a lost event. Because the notification of a held-back event has already come and gone, the
  dispatcher looks again when committed events wait above the horizon (`eventsHeldBack`), from 250 ms and doubling up to
  the sweep interval; a long-poll re-reads every second.
- A turn's outcome event commits a moment before Absurd marks its task finished. `busy` therefore means a turn task is
  active _and_ its outcome is not recorded, so a client that posts as soon as it sees `turn.completed` is not refused.
- Every emitting transaction gains one insert. Its `NOTIFY`s (`events` on the tenant database, `tenant_events` on
  control) go after the commit, never inside it: a `NOTIFY` in a writing transaction serializes commits across the whole
  cluster. Both are best effort; the long-poll's re-read and the dispatcher's sweep are the backstops.
- Delivery tasks of a disabled subscription are dropped when claimed; a deleted one's are cancelled. A redelivery is a
  new task.
- Not built: other destination kinds (an SQS or EventBridge adapter is the next one a customer asks for), a synchronous
  `Prefer: wait` mode, a tenant-wide SSE stream, and a CLI that forwards events to localhost. Each is a route over
  `packages/events` or a new adapter, with no change to the core.
