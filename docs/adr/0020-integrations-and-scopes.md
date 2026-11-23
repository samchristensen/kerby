# 0020. Integrations: who a key acts for, what it may do, and what it sees

- Status: proposed
- Date: 2026-11-23

## Context

An API key was a tenant and nothing else: every key could do everything, see every conversation and change every
setting. Customers wire several systems to one workspace (a support bot, a back office, a nightly job) and want each to
receive its own events (ADR 0019) and nothing else. Binding that to the key itself fails at the first rotation: the new
key would lose the old one's configuration.

## Decision

- **An integration** (`integrations` in the control database) is a named principal of a tenant that owns API keys,
  scopes and subscriptions. Keys rotate under it; its configuration does not move. Names are unique among a tenant's
  live integrations. Deleting one revokes its keys and deletes its subscriptions; the row stays, as keys do.
- **Five scopes**, held by the integration ([contracts](../../packages/contracts/src/integrations.ts)):
  `conversations` (create, post, read, stream, trace), `judgments` (submit, read), `events` (`GET /v1/events`),
  `tenant` (see everything in the tenant, not only what this integration started) and `admin` (model keys, prompts,
  subscriptions). Every route declares the scope it needs (`authed(route, scope, handler)`), so none can forget; a
  missing one is 403 `forbidden`, naming it.
- **Attribution and visibility.** A conversation and a judgment record the integration that started it (`integration_id`
  on `conversations`, `integrationId` in the judgment's task params; null when a person started it in the console), and
  so does every event. Without `tenant`, an integration sees only its own: another's conversation, judgment or event is
  404, the same answer as an id that does not exist. The repo functions take a `Visibility` argument, so a query cannot
  forget the filter. The worker, which is Kerby, sees the tenant.
- **A person in the console acts as the tenant**: a console session has every scope and tenant visibility; what it
  starts is attributed to no integration.
- **Every tenant gets a `default` integration with every scope** at provisioning; its first key belongs to it. The
  migration moved every existing key into one, so nothing a key could do changed. Operators' key routes take an optional
  `integrationId` and default to `default`.
- **Management**: integrations and their keys are made, re-scoped and deleted in the console (`kerby_console` gains the
  grants), audited as `user:<id>`. The api's role reads integrations and nothing more, so a key cannot mint keys.
- A scope change, a revoked key or a deleted integration takes effect within the auth cache TTL (`AUTH_CACHE_SECONDS`).

## Consequences

- Least privilege is possible: a key that only polls events, or only runs conversations, and cannot change where events
  go or read the tenant's model key list.
- A key without `tenant` cannot see conversations made in the console; that is the point.
- No API for integrations themselves: automation that must mint keys asks for it, behind `admin`, when it exists.
