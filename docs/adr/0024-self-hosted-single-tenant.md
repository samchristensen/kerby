# 0024. Self-hosted, single tenant first; SaaS operations parked

- Status: proposed
- Date: 2026-11-23

## Context

Kerby was built as a multi-tenant service ([0001](0001-platform-and-tenancy.md)). Before selling it, the owner will
dogfood it inside a few of his own projects: locally beside each project in Docker Compose, and hosted inside that
project's own Railway project. Each install serves one owner. Running one today means five services
(`control`, `api`, `worker`, `dispatcher`, `console`), three buckets (`kerby`, `kerby-exports`, `kerby-backup`), seven
generated secrets (`TENANT_DB_KEYS`, two key pairs, `OPERATOR_TOKEN`, `CONSOLE_TOKEN`, two role passwords), an operator call
to provision a tenant, and Kerby's own Railway project with its IaC, release scripts and canary. With one tenant, none of
that buys anything.

The code paths already run with one tenant: `make up` provisions `default`, and every product feature (turns, prompts,
judgments, guardrails, search, trace, events and delivery, tools, the SDK) works against a `TenantDb` without knowing
how many tenants exist. The expensive part to rebuild later is the tenancy seam: the control and tenant planes, the
`ControlDb`/`TenantDb` handles, Absurd per tenant database, sealed secrets ([0004](0004-database-per-tenant.md),
[0008](0008-byok-sealed-secrets.md), [0009](0009-tenant-database-credentials.md)).

## Decision

- **Keep the seam, drop the operations.** The control plane, a database per tenant, `TenantDb`/`ControlDb`, integrations
  and scopes ([0020](0020-integrations-and-scopes.md)), sealed secrets and the egress guard stay unchanged. An install has
  exactly one tenant, created by control at startup; nothing creates a second.
- **One image, one container.** A new deployable `services/kerby` is a launcher: it starts control, api, worker and
  dispatcher as child processes of one container (it never imports them, so services still meet only over HTTP and
  Postgres). `KERBY_ROLES` (default all four) picks which run, so a second container can add workers. If a child exits,
  the launcher stops the rest and exits nonzero; Docker or Railway restarts the container. Only the api's port is
  published. The per-service images are removed.
- **One secret.** `KERBY_SECRET_KEY` (32 bytes, base64) is the only generated secret. `packages/secrets` derives
  everything else from it with HKDF-SHA256, one `info` label per use: the `TENANT_DB_KEYS` key, the secrets key pair, the
  delivery key pair, and the `kerby_app` and `kerby_console` role passwords. Any 32 bytes are a valid X25519 private key,
  so the pairs derive directly (checked 2026-11-23). The api and worker now run in one container, so the api's process
  environment holds the private keys. That is acceptable when the owner runs every process. The services still take only
  the half they use. A rotation of the master key is a re-seal, out of scope until a rotation is needed.
- **Bootstrap from config.** At startup control ensures the tenant (`KERBY_TENANT_NAME`, default `default`) and its
  `default` integration. Given `KERBY_API_KEY` (a `kb_<id>_<secret>` key, `make secrets-key` makes one), it ensures that
  key exists with `admin`, so the host application can know the key before Kerby starts: in Railway, as a variable reference to
  the `kerby` service. Given `KERBY_ADMIN_EMAIL` and `KERBY_ADMIN_PASSWORD`, it ensures that console account.
  Password hashing moves from the console to a package both use.
- **The console is optional.** It is a second container (a Compose profile, an optional Railway service) taking
  `KERBY_SECRET_KEY`. Sign-up and the sign-up allowlist are removed; the bootstrapped admin signs in.
- **Postgres is Kerby's own instance.** Kerby creates databases and roles and closes `postgres` and `template1`,
  so it never shares an application's Postgres. Locally it is a Compose service; on Railway, a Postgres service of its
  own in the application's project.
- **SaaS operations are deleted, not hidden**, after tagging `saas-poc`: the operator HTTP API (provision, suspend,
  resume, delete, export, reissue, rotate, keys, migrate, backup, restore, console admins), exports and the export bucket,
  the nightly bucket copy and its freshness alarm, sign-up, `scripts/multitenant.ts`, Kerby's own Railway IaC and release
  scripts (`.railway/`, `scripts/railway.ts`, CI's Railway jobs) and the uptime canary. Control keeps migrations (both
  planes), role and template setup, the bootstrap, and nightly retention (`pruneTenants`). The isolation tests in
  `make test` stay: they guard the seam.
- **Railway is a recipe, not Kerby's IaC.** `docs/self-host.md` documents the services to add to an existing project (Postgres,
  one bucket, `kerby` from GHCR, optionally `console`) and their variables. CI keeps building and pushing the
  `kerby` and `kerby-console` images.

## Alternatives

- _A self-host profile with all SaaS code kept_: least churn, but every change keeps paying for features nobody runs
  (operator routes, exports, backups, sign-up, two release paths) and their docs and tests.
- _Remove tenancy (one database, no control plane)_: the least code, but SaaS later would mean rebuilding the hardest
  part, the isolation that fails closed.
- _Keep separate containers per service_: four Railway services in someone else's project for no isolation gain when one
  person runs every process. `KERBY_ROLES` keeps scale-out possible.
- _A Postgres shared with the host application_: one fewer service, but Kerby's role and database lockdown
  (`restrictClusterDatabases`, `restrictControlDatabase`) would change a database the application owns.
- _Blobs in Postgres instead of S3_: one fewer dependency, but a second `blobs` backend before a third use (principle 2);
  RustFS is one container and Railway has buckets.

## Consequences

- Supersedes [0007](0007-railway-hosting.md) and [0011](0011-images-from-ghcr.md) (Kerby's own Railway project, one
  image per service) and the export and backup halves of [0013](0013-exports-and-bucket-backup.md); amends
  [0001](0001-platform-and-tenancy.md) (sold as a service, later) and [0014](0014-tenant-console.md) (no sign-up).
- Backups are the install's Postgres and bucket backups (Railway's, or the owner's volume). Exports are `pg_dump` by the owner.
- Returning to SaaS is a plan, starting from `saas-poc`: restore the operator API, provisioning beyond one tenant,
  sign-up, and per-service images, and give each process only its own keys again.
- The architecture check's `docker` rule moves from "every service has a Dockerfile" to the two images that ship.
