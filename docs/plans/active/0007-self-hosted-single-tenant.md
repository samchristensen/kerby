# 0007. Self-hosted, single tenant

Goal: Kerby runs beside any of the owner's projects as one tenant: `docker compose up` locally, or a few services added
to that project's Railway project, with one generated secret and nothing to provision by hand. SaaS-only operations are
deleted (recoverable from the tag `saas-poc`). Decision: [ADR 0024](../../adr/0024-self-hosted-single-tenant.md).

## Open questions (block the named milestone)

- ~~Tear down the live Railway project `kerby`?~~ The owner said yes (2026-11-23). Then found: it serves a live tenant,
  `lochmoore` (6 conversations, 26 messages, a model key; last message 2026-11-23 19:24 UTC), so the lochmoore app calls
  it. Before deleting: move lochmoore to an install of its own (K6's proof), or confirm its data may go. Blocks K5's
  last item. **Human.**

## Milestones

### K1 One secret

- [x] `deriveInstanceKeys(masterBase64)` in `packages/secrets`: HKDF-SHA256, one `info` label per use, returning the
  `TENANT_DB_KEYS` key, the secrets pair, the delivery pair, and the `kerby_app` and `kerby_console` passwords. Refuses a
  master that is not 32 bytes. Tests: stable for one master (pinned), distinct per label, each pair seals and opens.
- [x] `make secrets-key` prints a `KERBY_SECRET_KEY` and a `KERBY_API_KEY` (`newApiKey` in `packages/control-plane`).

### K2 Bootstrap in control

- [x] Password hashing moved from the console to `packages/control-plane` (`passwords.ts`, its test with it).
- [x] Control config gains `KERBY_TENANT_NAME` (default `default`), `KERBY_API_KEY`, `KERBY_ADMIN_EMAIL`,
  `KERBY_ADMIN_PASSWORD` (both or neither; at least a key or an admin). At start, after migrating every database
  (`bootstrapInstance`): provision the tenant if none is live, refuse to start with two, clear one a start left half
  made, wake a suspended one. `ensureConfiguredApiKey` keeps the configured key live on `default` and revokes the one
  configured before it. The admin is the tenant's only console account; its password follows config.
- [x] Tests on real Postgres (`services/control/src/control.test.ts`, "the install"): first start, a second that
  changes nothing, key replaced and restored, a key that is not one or whose id is taken, admin password and email
  replaced (sessions with it), two tenants refused, a half-made tenant cleared.

### K3 The launcher

- [x] `services/kerby`: config `KERBY_SECRET_KEY`, `DATABASE_URL`, `KERBY_ROLES`, `HOST`/`PORT` (the api's),
  `KERBY_WATCH`. `processSpecs` derives each child's variables and database URL (`postgresUrl` in `@kerby/db`); the rest
  of the environment passes through `childProcessEnv`. Control starts first and the rest once its `/healthz` answers;
  a child's exit stops the rest and exits 1; `SIGTERM` stops all. Each JSON line gets `service`. `health` checks every
  role this container runs (the image's `HEALTHCHECK`).
- [x] One `services/kerby/Dockerfile` (`dev`, `prod`, `HEALTHCHECK`); the Dockerfiles of control, api, worker and
  dispatcher are deleted. Rule `docker`: a service ships in its own image or is installed by another's.
- [x] Control's HTTP server answers `/healthz` only; the release command is gone (control migrates at every start).

### K4 Local stack

- [x] `compose.yaml`: `postgres`, `rustfs`, `kerby`, `console`, and `worker` (profile `workers`, `KERBY_ROLES=worker`).
  Development values for `KERBY_SECRET_KEY`, `KERBY_API_KEY` and the admin. `make up` prints the key and the admin;
  `scripts/provision-default.sh` is deleted (`stackApiKey()` in `scripts/stack.ts`).
- [x] `make e2e`: `kerby` with `KERBY_ROLES=control,api,dispatcher` plus two worker containers; its checks name its own
  conversation, so a kept stack passes too. `make tools-e2e` and `make sdk-e2e` pass on the new stack.
- [x] Proof: a fresh project (`KERBY_PROJECT=kerby-selfhost`), a streamed turn with the printed key, sign-in to the
  console as the admin in a browser, a restart that changes nothing, a killed child that takes the container down.

### K5 Delete SaaS operations

- [x] Tag `saas-poc` on `main` before the first deletion.
- [x] Control: the operator API and `OPERATOR_TOKEN`, exports (`kerby-exports`, `EXPORT_S3_*`, `pg_dump`), the nightly
  bucket copy and its freshness alarm (`kerby-backup`, `BACKUP_S3_*`), sign-up and `CONSOLE_TOKEN`. Kept: migrations,
  roles, template, bootstrap, `pruneTenants`.
- [x] Control plane: `0010_no_signup.sql` drops `signup_allowlist` and the console admin flag. The console lost sign-up,
  the allowlist admin page and its control client.
- [x] Contracts (`operator.ts`, `console.ts` → `install.ts`), `Bucket` presigning, multipart upload and copy, the
  presigner and `railway` dependencies, `dumpDatabase`.
- [x] Scripts and CI: `scripts/multitenant.ts` and its make target, the Railway path of `scripts/logs.ts`,
  `scripts/railway.ts`, `.railway/`, the `railway-*`, `deploy` and `env-down` targets, CI's Railway jobs (images now
  `kerby` and `kerby-console`), `uptime.yml`. Nightly keeps `make e2e`.
- [ ] The live Railway project, per the open question above.

### K6 Inside a Railway project

- [x] Egress: `EGRESS_ALLOWED_HOSTS` and `ALLOW_LOCAL_DESTINATIONS` are accepted outside development (ADR 0010
  amendment), so a tool or webhook on `*.railway.internal` or a Compose service name works.
- [x] `docs/deploy.md`: the Compose snippet for another project (GHCR images), the Railway recipe, every variable, the
  application's references (`${{kerby.KERBY_API_KEY}}`, `http://kerby.railway.internal:8080`). The Compose snippet was
  run as written against the locally built image in production mode.
- [ ] Proof: the recipe followed in a scratch Railway project beside a small app that streams a turn through the SDK.
  Needs the images on GHCR, so a merge to `main` first (CI pushes them).

### K7 Docs

- [x] ARCHITECTURE.md (intro, services, Tenancy, Local stack, Hosting), AGENTS.md's opening, docs/README.md,
  docs/deploy.md rewritten as the install guide, `packages/sdk/INTEGRATION.md` where it names hosting.
- [x] ADRs: 0007, 0011, 0012, 0013 superseded by 0024; 0001, 0010, 0014, 0023 amended. Tech-debt lines about deleted
  features removed or rewritten; plan 0001 notes what 0024 parked; plans 0003, 0005, 0006 moved to `done/`, and
  `make docs` leaves done plans and superseded ADRs alone.

## Not in this plan

Rotating `KERBY_SECRET_KEY` (a re-seal), merging the control and tenant planes into one database, blobs in Postgres, a
second tenant, and the return to SaaS (a plan of its own, starting from `saas-poc`).

## Log

- 2026-11-23 Planned. Measured: one HKDF-derived 32-byte seed is a valid X25519 private key; `publicKeyOf` and
  seal/open round-trip. Control's startup closes `postgres`, `template1` and its own database to `public`
  (`restrictClusterDatabases`, `restrictControlDatabase`), so Kerby gets its own Postgres.
- 2026-11-23 K1 to K5 (but the teardown), K6's code and docs, and K7 built. Smoked on a fresh Compose project: control
  made the tenant, key and admin in under a second, then api, worker and dispatcher started; a streamed turn with a tool
  call; the console signed in as the admin and listed the API's chats; `/signup` and `/dashboard/admin` are 404; a
  restart kept one tenant, one key, one admin; `kill -9` of the worker child exited the container with 1. `make e2e`,
  `make tools-e2e` and `make sdk-e2e` green on it. A stack from before this change holds tenants sealed with other keys
  and is refused (two tenants) or cannot open them: `make down-v` once. Found: the old `make e2e` checks read whole
  tables, so they failed on a kept stack; they now name their conversation. Production holds a live `lochmoore` tenant,
  so its teardown waits for the owner.
