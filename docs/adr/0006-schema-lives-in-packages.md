# 0006. Shared schema and its queries live in packages, not in a service

- Status: proposed
- Date: 2026-11-21

## Context

Plan 0002 put the control migrations in `services/control` and the conversation migrations in `services/api`. But
services never import each other, and several services need the same tables: `api` (key verification), `worker`
(tenant lookup, usage) and `control` (everything) all read the control plane; `api` and `worker` both read and write
a tenant's `messages`. Control also has to apply the tenant schema it never wrote. Keeping SQL in one service would
mean duplicating it or reaching across services.

## Decision

- `packages/control-plane` owns `migrations/control/` and the control-plane queries. Exports `controlMigrationsDir`.
- `packages/conversations` (added with the turn pipeline) owns the conversation and message tables in its
  `migrations/tenant/` and their queries. `packages/durable` and `packages/blobs` own their own tenant migrations.
- Each such package exports its migration directory. The service that provisions or migrates tenants (`control`)
  lists them in order: durable, blobs, conversations. `migrate` records each file as `<workspace>/<file>`.
- Test helpers that need a migrated database (`createTestControlDb`, `createTestTenant`) live in the package that owns
  the schema (`@kerby/<pkg>/testing`).

## Consequences

- A change to a table is one edit in one package, seen by every service that uses it.
- A service owns no tables: "each owns its tables" in ARCHITECTURE.md now means each package owns its tables.
- Rejected: a shared `@kerby/schema` package holding all SQL (one package with many reasons to change); control
  exposing the data over HTTP to api and worker (a network hop on every request for auth).
