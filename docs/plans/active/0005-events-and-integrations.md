# 0005. Events for consumers: integrations, the event log, delivery

Goal: a customer chooses, per integration, how it hears about its agents' work: not at all, by polling the event log,
or by signed webhooks; least privilege per key; nothing lost, nothing pushed to the wrong tenant or integration.
Decisions: [ADR 0019](../../adr/0019-events-and-delivery.md) (event log, delivery, dispatcher, Standard Webhooks) and
[ADR 0020](../../adr/0020-integrations-and-scopes.md) (integrations, scopes, visibility). The owner's answers
(2026-11-23): an integration owns keys; subscription scope chosen per subscription; subscriptions are managed in the
console or with an `admin` key; payloads always thin; delivery unordered with `seq`; ship durable events, polling and
webhooks first behind a port that takes more destination kinds; reads scoped like events. No customers yet, so no
compatibility shims.

## Milestones

### E1 Integrations and scopes

- [x] Control migration: `integrations`, `api_keys.integration_id` (every existing key moved into a `default` integration
  with every scope), grants for `kerby_app` and `kerby_console`
- [x] api: a principal has an integration, scopes and a visibility; every route declares its scope (403 `forbidden`)
- [x] Attribution (`conversations.integration_id`, judgment params) and visibility on every read: another integration's
  conversation, judgment or event is 404 without the `tenant` scope
- [x] Provisioning and operator keys go through the `default` integration; tenant deletion purges integrations and subscriptions
- [x] Console: integrations (create, scopes, delete) and their keys replace the API keys pages

### E2 The event log

- [x] `packages/events`: the outbox table, `(tx, position)` cursor under the xmin horizon, dedupe keys
- [x] Events recorded in the emitting transactions: conversation, user and persisted messages, turn start and one outcome
  per turn on every exit path, judgment outcome; a live `run_end` on every turn path (new reason `failed`)
- [x] `GET /v1/events` with filters and long-poll, counted with SSE streams
- [x] Retention: control's nightly job prunes events and delivery attempts past 30 days and runs Absurd's cleanup

### E3 Delivery

- [x] `packages/delivery` port and `packages/delivery-webhook` (Standard Webhooks v1, egress, 1 KiB of response kept)
- [x] `services/dispatcher`: fan-out under the cursor lock, `deliveries` queue, per-tenant and process caps, retries,
  410 and 48-hour auto-disable; signing secrets on their own key pair
- [x] `/v1/subscriptions`: create, list, get, update, delete, rotate secret, test ping, delivery log, redeliver; audited
- [x] Console: subscriptions with secret shown once, test, delivery log
- [x] Compose, Railway IaC, CI image, deploy order, secrets for the delivery key pair

### E4 Proof

- [x] `make check`, `make test` green
- [x] Real stack: a signed webhook received and verified at a local receiver; polling and long-poll; a rotated secret
  signs twice; a dead endpoint retried and its attempts listed
- [x] `make multitenant`: cross-tenant and cross-integration attempts on events and subscriptions refused
- [ ] Production: `DELIVERY_SECRETS_*` created by `make railway-setup`, the dispatcher deployed (needs the owner's go)

## Not in this plan

Other destination kinds (SQS, EventBridge, Pub/Sub), a synchronous `Prefer: wait` mode on posting a message, a
tenant-wide SSE stream, a CLI that forwards events to localhost, an API for integrations themselves.

## Log

- 2026-11-23 Plan, ADR 0019 and ADR 0020 written after the owner's design answers; built in the `events` worktree.
- 2026-11-23 Built in parallel slices (api, worker, packages, dispatcher, control, console) on a shared foundation
  (contracts, control-plane repo, `packages/events`, the port, the `deliveries` queue). Integration findings fixed: an
  `admin` key without `tenant` could manage other integrations' subscriptions (now 404, regression test); events held
  behind the cluster-wide horizon waited for the sweep (dispatcher now re-checks with backoff, `eventsHeldBack`); every
  tenant's events made the dispatcher open that tenant's database (now skipped without a subscription row, which made
  deleted subscriptions tombstones the dispatcher finishes: cancels queued deliveries, drops the cursor); a client acting
  on `turn.completed` at once got 409 because the outcome commits before Absurd closes the task (busy now excludes a turn
  with an outcome, regression test); `createApiKey` failed on every call (parameter typing); two test files set different
  passwords on the cluster-wide `kerby_console` role (shared `asServiceRole`); a session test expired 1 ms back against
  Docker's clock. `make check` and `make test` green (484 tests).
- 2026-11-23 Real stack (`make up` in the worktree, a receiver on the host verifying signatures independently): a turn's
  7 webhooks arrived signed and verified within a second, thin (no message text); long-poll answered 46 ms after the turn
  started; ping; rotation signs twice and both verify; 500 logged `failed`, retried; 410 disabled; a deleted subscription's
  pending retry cancelled, cursor dropped, tombstone purged; dispatcher logs carry no URL, body or secret. Console: signed
  up, made `back office` (conversations, events), its key, a `turn.*` subscription (secret shown once, tenant scope
  disabled), sent a test, read the delivery log. That key got 404 on the default integration's conversation, stream and
  post, 403 on subscriptions, judgments and model keys, and none of its events; its subscription received only its own.
- Unexplained, once in about eight full runs: `packages/conversations` "records conversation.created and message.created
  ... once each" read the assistant's `message.created` before `conversation.created` (an older transaction id for a
  later write). Not reproduced in 180 probe sequences under load; cursor completeness does not depend on it.
- 2026-11-23 Merged `main` (sign-up allowlist, console rebrand, architecture review, pre-deploy migrations). The control
  migration is now `0009_integrations.sql`. Events are still recorded in the writing transaction, but every `NOTIFY` moved
  after the commit (`announceEvents`), following the review's finding that a `NOTIFY` in a writing transaction
  serializes commits cluster-wide. Integration and subscription lookups compare uuids with `isUuid` guards (rule
  `queries`). Keys keep the 50-per-tenant cap (the console's integration page explains the refusal). The integration
  pages use the Operator tokens. `make check` and `make test` green (514 tests).
