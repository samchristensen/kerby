# 0004. A database per tenant, behind a control plane

- Status: proposed
- Date: 2026-11-21

## Context

[0001](0001-platform-and-tenancy.md) makes tenants untrusted customers. A `tenant_id` column plus discipline fails
open: one missing `where` leaks across customers. A database per tenant fails closed: a query can only reach the
database it was handed. It also makes export, deletion, restore, residency, and a dedicated-cluster tier ordinary
operations on one database.

## Decision

- **Two planes.**
  - _Control plane_: one database (`migrations/control/`) holding `tenants` (status, plan, limits, region, database
    and storage locators), `api_keys` (hashed), `tenant_secrets` (encrypted), `usage`, and the audit log. Every table
    names its tenant or says it is global (checked).
  - _Tenant plane_: one Postgres database per tenant (`migrations/tenant/`) holding conversations, messages, the blob
    index, tool registrations, and the **Absurd schema and queues**, so a tenant's durable state is entirely in its
    database. No `tenant_id` column is needed there; the database is the boundary.
- **Placement.** A tenant row names its cluster and database. Many tenants share a cluster; a large or regulated
  tenant gets its own, and the region pins where. Provisioning creates a database and a role that can reach only it.
- **Handles, not pools.** `packages/db` exports two distinct types, `ControlDb` and `TenantDb`. Repo functions take one
  of them, never a pool or a DSN. A `TenantDb` is obtained only by resolving a verified API key to a tenant
  (`packages/db` keeps a small LRU of pools, evicting idle ones). The type system stops a tenant query from running on
  the control plane and the reverse.
- **Authentication** resolves `API key -> tenant` in the control plane (cached briefly; suspension takes effect within
  the cache TTL) and returns a tenant context. Nothing downstream accepts a tenant id from a request body.
- **The worker serves many databases.** It keeps a tenant scheduler: it learns of work from a `NOTIFY` on the control
  database (sent by the api after it spawns a turn in the tenant's database, at-least-once, with a slow sweep as the
  backstop), then claims Absurd tasks from that tenant's database. Because the worker chooses whom to claim for,
  per-tenant concurrency and fair sharing are enforced there, which Absurd itself does not do. The limit holds across
  workers: each claim takes an advisory lock in the tenant's database, counts the runs holding a live lease, and
  claims at most the difference, in the same transaction.
- **Object storage.** Keys start with `t/<tenantId>/`; `packages/blobs` takes a tenant context on every call. A tenant
  may be assigned its own bucket in its row. The blob index lives in the tenant database.
- **Secrets.** Tenant model keys and tool credentials are envelope-encrypted in the control plane, with a per-tenant data
  key, and decrypted only inside a run. Logs carry the tenant id and never message content or secrets.
- **Migrations.** Control migrations run once; tenant migrations fan out to every tenant database, recorded per tenant
  (`tenants.schema_version`). Releases are expand-then-contract: code runs against version n and n-1 while a rollout is
  in flight.
- **Lifecycle.** Provision (database, role, migrations, queues, first key), suspend (auth refuses), export (`pg_dump`
  plus the object prefix), delete (drop database, delete prefix, purge keys and secrets). Each is an operator command
  in `services/control`.
- **Local development** is the same code: one Postgres container, a control database, and a `default` tenant
  provisioned by `make up`.

## Consequences

- Measured (plan 0001 log): the SDK claims on demand (`claimTasks`); 1000 tenant databases provision from a template in
  22 ms each; an LRU of 50 pools serves 1000 databases with 5.7 ms cold opens. A full sweep of 1000 tenants costs about 4 s, so the
  worker claims for hinted tenants and sweeps a bounded set. Not yet measured: 10k tenants, Postgres backend memory, cross-host latency.
- New service `services/control` (operator API, provisioning, migration fan-out). Public `services/api` and
  `services/worker` stay tenant-agnostic code.
- Cross-tenant queries (usage, billing) read the control plane, which the worker feeds from each assistant message's usage.
- An agent runtime shares a worker process across tenants but never state: each run opens a fresh in-memory harness.
  Tools are remote (MCP over HTTP); code execution, if ever offered, runs outside Kerby's processes.

## Rejected

- Shared tables with `tenant_id` and row-level security: one policy mistake leaks; per-tenant export and deletion
  become row hunts.
- Absurd in the control plane: tool results in step values would sit in a shared database and survive tenant deletion.
- A schema per tenant: shares a database's connections and failure domain without the isolation.
