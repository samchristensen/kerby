# 0007. Self-hosted, single tenant

Goal: Kerby runs beside any of the owner's projects as one tenant: `docker compose up` locally, or a few services added
to that project's Railway project, with one generated secret and nothing to provision by hand. SaaS-only operations are
deleted (recoverable from the tag `saas-poc`). Decision: [ADR 0024](../../adr/0024-self-hosted-single-tenant.md).

## Open questions (block the named milestone)

- ~~Tear down the live Railway project `kerby`?~~ Yes, though it served a live `lochmoore` tenant (6 conversations,
  26 messages, a model key): the owner chose deleting it over moving lochmoore first (2026-11-24). Done.

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
- [x] The live Railway project `kerby`: deleted (2026-11-24; Railway removes it for good on 2026-11-26).

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
- 2026-11-24 Railway project `kerby` deleted with `railway delete` (the owner's call, knowing lochmoore used it):
  Railway stopped its services at once (the console's domain answers 404) and removes the project, its Postgres volume,
  backups and buckets on 2026-11-26 06:31 UTC; until then the dashboard can restore it. Lochmoore's Kerby integration is
  down until it points at an install of its own (K6's proof). The repository secrets the deleted CI jobs read
  (`RAILWAY_TOKEN`, `GHCR_PULL_TOKEN`, `KERBY_CANARY_KEY`, variables `KERBY_API_URL`, `KERBY_CANARY_CONVERSATION_ID`) are
  unused now; the owner may delete them.
- 2026-11-24 K6's proof, in part. `docs/deploy.md`'s Compose snippet (verbatim) plus the console service ran from a
  scratch directory on prod images built from this tree and tagged as the GHCR names: healthy in 9 s, tenant and key
  made, a second start made no tenant; an `app` container that installed `@kerby/sdk` v0.1.1 from the private repository
  inside a Docker build (token as a build secret) ran `ask`, `streamReply` and a verified webhook to `http://app:3000`;
  the admin signed in to the console in a browser. Not proven: the images are not on GHCR (`ghcr.io/samchristensen/kerby`
  does not exist; the packages there are the old per-service ones, all private), so the pull, and the Railway recipe,
  wait for a merge to `main`. Found: the images are amd64 only and the `kerby` image carries the console's dependencies
  (both in tech-debt); the SDK lockfile records an SSH address, so CI and Docker builds need a key or token and `git`
  (now in the SDK guide); npm 12 refuses the git dependency without `--allow-git=all` (same).
- 2026-11-24 Opened ([ADR 0025](../../adr/0025-public-repository-sdk-on-npm.md)). `samchristensen/kerby` is public under
  MIT: gitleaks over 106 commits found 21 test fixtures and development-only keys, nothing live; the throwaway Railway
  probe branch is deleted; private vulnerability reporting is on. The SDK publishes to npm from CI as
  `@samchristensen/kerby-sdk` (the `@kerby` scope is another npm account's), so the `kerby-sdk` repository is not needed.
  A `make sdk-publish DRY=1` run was accepted by the registry; the packed tarball installed with npm and pnpm and passed
  `tsc --strict` with `skipLibCheck: false`. PR 24 is green. Pending, in order: the npm org `samchristensen`; a hand-made
  `0.1.0` (npm binds a trusted publisher only to a package that exists) and `npm trust github`; the merge; `kerby-console`
  made public on GHCR (its first push predates the public repository); then `samchristensen/kerby-sdk` and the
  `SDK_DEPLOY_KEY` secret deleted.
- 2026-11-24 Shipped (ADR 0025). PR 24 merged. `@samchristensen/kerby-sdk` 0.1.0 was published by hand, then
  `npm trust github` bound `ci.yml`; `0.1.1`, published by CI, carries signed provenance (`npm audit signatures`
  verifies it), and a `main` run with an unchanged build reports "nothing to publish", so the byte comparison holds
  between a Mac build and a Linux runner. The `kerby-sdk` repository and `SDK_DEPLOY_KEY` are deleted.
  `ghcr.io/samchristensen/kerby` is public (it took the repository's visibility at its first push); `kerby-console` was
  created while private and GHCR has no API to change that, so it stays private until its package settings are changed.
  K6's proof, in part again: the `docs/deploy.md` snippet verbatim, an anonymous pull from GHCR, an app in plain
  `node:26-slim` installing the SDK from npm with no git or token, then `ask`, `streamReply` and a verified webhook, and a
  restart that made no second tenant. Found and fixed: on Apple Silicon the snippet failed with `no matching manifest for
  linux/arm64/v8` (the images were amd64 only; `platform: linux/amd64` made it run), so CI builds both; a dispatcher
  test raced (one `update ... available_at` could land while the task still ran) and blocked the `sdk` job, which needs
  `test`. Not proven: the Railway recipe.
- 2026-11-24 Roles split, and the guide for agents. Ran control, api, worker and dispatcher each in its own container from
  the published image, with no ordering between them: 1 control, 2 api, 3 then 9 workers, 2 dispatchers, all healthy; a
  turn, a streamed reply and a signed webhook (sent by the dispatcher container) went through. Found: a role that starts
  before control exits with `password authentication failed for user "kerby_app"` and needs a restart policy; the tenant
  role's 20-connection limit is a constant, not the setting `docs/deploy.md` implied (wording fixed, limit in tech-debt).
  `docs/deploy.md` gained "Deploying with an agent" (stable raw URLs, what to settle with the owner, when it is done),
  `openssl` secrets for a deploy without a clone (accepted by `parseApiKey` and `deriveInstanceKeys`), and "Running the
  roles separately". Cleaned up: the superseded per-service GHCR packages (gone), the four repository secrets and two
  variables no workflow reads, eight merged local branches. Left: `kerby-console` is still private, and `kerby-runner`,
  `kerby-admin`, `kerby-ui` (not from this repository) are the owner's to remove.
