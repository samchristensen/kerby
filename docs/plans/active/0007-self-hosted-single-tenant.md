# 0007. Self-hosted, single tenant

Goal: Kerby runs beside any of the owner's projects as one tenant: `docker compose up` locally, or a few services added
to that project's Railway project, with one generated secret and nothing to provision by hand. SaaS-only operations are
deleted (recoverable from the tag `saas-poc`). Decision: [ADR 0024](../../adr/0024-self-hosted-single-tenant.md).

## Open questions (block the named milestone)

- The live Railway project `kerby` (environment `production`, the `canary` tenant, the `uptime` workflow, CI's deploy on
  merge): tear it down, or leave it running unmanaged until the owner deletes it? Blocks K5's last item. **Human.**

## Milestones

### K1 One secret

- [ ] `deriveInstanceKeys(masterBase64)` in `packages/secrets`: HKDF-SHA256, one `info` label per use, returning the
  `TENANT_DB_KEYS` key, the secrets pair, the delivery pair, and the `kerby_app` and `kerby_console` passwords. Refuses a
  master that is not 32 bytes. Tests: stable for one master, distinct per label, each pair seals and opens.
- [ ] `make secrets-key` prints a `KERBY_SECRET_KEY` and a `KERBY_API_KEY` (`kb_<12 hex>_<43 base64url>`), nothing else.

### K2 Bootstrap in control

- [ ] Password hashing (`services/console/src/service/passwords.ts`) moves to `packages/control-plane`; the console
  imports it from there.
- [ ] Control config gains `KERBY_TENANT_NAME` (default `default`), `KERBY_API_KEY`, `KERBY_ADMIN_EMAIL`,
  `KERBY_ADMIN_PASSWORD` (both or neither). At startup, after migrations: provision the tenant if no live tenant
  exists, and refuse to start if more than one does. Ensure the configured key exists on the `default` integration
  (inserted by its id and hash; a bootstrap key no longer configured is revoked). Ensure the admin account exists,
  and reset its password hash when the configured password changes.
- [ ] Tests on real Postgres: a first start provisions, a second changes nothing, a changed key revokes the old one,
  a second live tenant fails startup naming the fix.

### K3 The launcher

- [ ] `services/kerby`: config `KERBY_SECRET_KEY`, `DATABASE_URL` (the superuser of Kerby's own Postgres), `S3_*`,
  `KERBY_ROLES` (`control,api,worker,dispatcher` by default), and the settings it passes on. It derives each child's
  variables (K1) and builds their database URLs. Passing the rest of the environment on goes through `packages/config`,
  which is still the only reader of the process environment. It runs control's setup to completion, then starts the
  roles. When a child exits, it stops the rest and exits nonzero; it forwards `SIGTERM`. Health is the api's `/healthz`
  (or the first role's).
- [ ] One `Dockerfile` (`dev`, `prod`, `HEALTHCHECK`) installing the four services; the per-service Dockerfiles of
  control, api, worker and dispatcher are deleted. The architecture rule `docker` names the images that ship
  (`kerby`, `console`).
- [ ] Control's HTTP server keeps `/healthz` only (K5 removes the rest); its release command stays for `KERBY_ROLES`
  without `control`.

### K4 Local stack

- [ ] `compose.yaml`: `postgres`, `rustfs`, `kerby`, and `console` (profile `console`, which `make up` turns on).
  Development values for `KERBY_SECRET_KEY`, `KERBY_API_KEY` and the admin. `make up` prints the key and the console's
  address; `scripts/provision-default.sh` is deleted.
- [ ] `make e2e`: `kerby` with `KERBY_ROLES=control,api,dispatcher` plus two `KERBY_ROLES=worker` containers; killing a
  worker mid-turn still finishes the turn elsewhere. `make tools-e2e` and `make sdk-e2e` pass on the new stack.
- [ ] Proof: `make down-v && make up`, a streamed turn with the printed key, sign in to the console as the admin.

### K5 Delete SaaS operations

- [ ] Tag `saas-poc` on `main` before the first deletion.
- [ ] Control: the operator API and `OPERATOR_TOKEN`, exports (`kerby-exports`, `EXPORT_S3_*`, `pg_dump`), the nightly
  bucket copy and its freshness alarm (`kerby-backup`, `BACKUP_S3_*`), sign-up and `CONSOLE_TOKEN`. Kept: migrations,
  roles, template, bootstrap, `pruneTenants`.
- [ ] Control plane: a migration drops `signup_allowlist` and the console admin flag. The console loses sign-up, the
  allowlist admin page and its control client.
- [ ] Contracts and tests that only served those routes (knip finds the rest).
- [ ] Scripts and CI: `scripts/multitenant.ts` and `make multitenant`, the Railway path of `scripts/logs.ts`,
  `scripts/railway.ts`, `.railway/`, the `railway-*`, `deploy` and `env-down` targets, CI's Railway jobs (images now
  `kerby` and `kerby-console`), `uptime.yml`. Nightly keeps `make e2e`.
- [ ] The live Railway project, per the open question above.

### K6 Inside a Railway project

- [ ] Egress: a self-host lets its own private services through. `EGRESS_ALLOWED_HOSTS` and `ALLOW_LOCAL_DESTINATIONS`
  are accepted outside development (an ADR 0010 amendment), so a tool or webhook on `*.railway.internal` or a Compose
  service name works.
- [ ] `docs/self-host.md`: the Compose snippet for another project (GHCR images), and the Railway recipe: a Postgres
  service of Kerby's own, one bucket, `kerby` (private networking; a public domain only if something outside calls
  it), `console` if wanted. Every variable, and the application's references (`${{kerby.KERBY_API_KEY}}`,
  `http://kerby.railway.internal:8080`).
- [ ] Proof: the recipe followed in a scratch Railway project beside a small app that streams a turn through the SDK.

### K7 Docs

- [ ] ARCHITECTURE.md (services, Tenancy's lifecycle and sign-up, Local stack, Hosting), AGENTS.md's opening, docs/README.md
  (`deploy.md` replaced by `self-host.md`), `packages/sdk/INTEGRATION.md` where it names hosting.
- [ ] ADR statuses: 0007 and 0011 superseded by 0024; 0001, 0013, 0014 amended. Tech-debt lines about deleted
  features removed; plans 0001 and 0003 note what 0024 parked.

## Not in this plan

Rotating `KERBY_SECRET_KEY` (a re-seal), merging the control and tenant planes into one database, blobs in Postgres, a
second tenant, and the return to SaaS (a plan of its own, starting from `saas-poc`).

## Log

- 2026-11-23 Planned. Measured: one HKDF-derived 32-byte seed is a valid X25519 private key; `publicKeyOf` and
  seal/open round-trip. Control's startup closes `postgres`, `template1` and its own database to `public`
  (`restrictClusterDatabases`, `restrictControlDatabase`), so Kerby gets its own Postgres.
