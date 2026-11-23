# Deploying to Railway

What `.railway/railway.ts` (Railway Infrastructure as Code), CI (`.github/workflows/ci.yml`) and `scripts/railway.ts` create,
and how to run them. Why: [ADR 0007](adr/0007-railway-hosting.md), [ADR 0011](adr/0011-images-from-ghcr.md). Status:
deployed and smoke-tested on a real project (plan 0001 log, 2026-11-22).

## What exists

One Railway project, `kerby`. Per environment (`production` is the standing one):

| Service                | What                                                                                                                                                             | Reachable from                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Postgres`             | Railway's PostgreSQL template (18) on a volume; holds the control database and every tenant database                                                             | the other services, privately                                                      |
| bucket `kerby`         | Railway bucket (S3-compatible, `iad`); every object is under `t/<tenantId>/`                                                                                     | the other services, by endpoint and keys                                           |
| bucket `kerby-exports` | tenant exports (`<tenantId>/<stamp>.dump`, `.objects.json`), kept 30 days                                                                                        | `control` only, by its keys; presigned URLs                                        |
| bucket `kerby-backup`  | nightly copy of `kerby`'s `t/`, in `sjc` ([ADR 0013](adr/0013-exports-and-bucket-backup.md))                                                                     | `control` only, by its keys                                                        |
| `control`              | operator API (`:8081`), no public domain; listens on `::` for the private network                                                                                | `railway ssh --service control`; the console, privately, on its sign-up route only |
| `api`                  | tenant API (`:8080`), public Railway domain; listens on `::` for the private network                                                                             | the internet; the console, privately, with a person's session token                |
| `worker`               | runs turns, health on `:8082`, no public domain                                                                                                                  | nothing                                                                            |
| `dispatcher`           | pushes events to subscriptions ([ADR 0019](adr/0019-events-and-delivery.md)), health on `:8083`, no public domain; posts to the internet                         | nothing                                                                            |
| `console`              | tenant console (`:3000`): sign-up, sign-in, integrations and their keys, subscriptions, model keys, chat ([ADR 0014](adr/0014-tenant-console.md)); public domain | the internet                                                                       |

`control`, `api`, `worker`, `dispatcher` and `console` run the images CI builds from `services/<name>/Dockerfile` (stage `prod`) and pushes to GHCR
(`ghcr.io/samchristensen/kerby-<name>`); Railway builds nothing. Each environment runs the tag named after it
(`kerby-api:production`); a release moves that tag. Services are health-checked on `/healthz`. Postgres is reached at
`postgres.railway.internal` on the private network, without TLS.

## First time

You need the Railway CLI (5.42.1 or newer), signed in (`railway login`), Node (the scripts run TypeScript directly), and
Docker logged in to GHCR with a token that can push (`gh auth token | docker login ghcr.io -u <user> --password-stdin`).

```sh
railway init --name kerby                  # creates the project and links this checkout to it
make railway-plan                          # preview: what .railway/railway.ts would change
make railway-setup                         # apply it, add the api's and console's domains, create the secrets once
GHCR_PULL_TOKEN=... make railway-registry  # let the services pull the private images (classic token, read:packages)
make deploy TAG=sha-<commit>               # a commit CI built: control first, then the rest; waits for SUCCESS
```

After that, merging to `main` releases (see Releasing); `make deploy` is for rollbacks and other environments.

The infrastructure lives in [`.railway/railway.ts`](../.railway/railway.ts): edit it, `make railway-plan`, then `make
railway-setup`. The CLI shows the diff and applies it; a deletion (a service, a variable) is refused without a person
confirming it, so run `railway config apply` yourself for those. Do not change infrastructure in the dashboard: the next plan
shows it as drift, and `railway config pull` imports it if you did. `railway-setup` is safe to run again; it never replaces
a secret. Kerby holds no model provider keys: each tenant
stores its own (`PUT /v1/model-keys/<provider>`, [ADR 0008](adr/0008-byok-sealed-secrets.md)). The setup makes a secrets key
pair once: the private key is `SECRETS_PRIVATE_KEYS` on `worker`, the public half `SECRETS_PUBLIC_KEY` on `api`. Never delete
the private key from `worker`: every stored tenant key is sealed to it. Its copy outside Railway is the operator's macOS
login keychain item `kerby SECRETS_PRIVATE_KEYS` (account `kerby-production`); keep a second copy in a password manager.
Check a copy is the live key: `publicKeyOf(copy)` from `@kerby/secrets` must equal `api`'s `SECRETS_PUBLIC_KEY`. After
a key rotation (ADR 0008), update the copy. It also makes a delivery secrets key pair once ([ADR 0019](adr/0019-events-and-delivery.md)):
`DELIVERY_SECRETS_PRIVATE_KEYS` on `dispatcher`, `DELIVERY_SECRETS_PUBLIC_KEY` on `api`. Every subscription's signing secret
is sealed to it: lose the private key and every subscription must have its secret rotated (`POST /v1/subscriptions/:id/secret`)
and its receiver updated, so keep a copy beside the other (keychain item `kerby DELIVERY_SECRETS_PRIVATE_KEYS`).

The api's and the console's addresses are in `railway service list --json` (`url`). A custom domain: add
`domains: ["api.example.com"]` to the service in `.railway/railway.ts` and apply, then add the DNS records Railway prints.
The console shows the api's address in its quickstart (`API_PUBLIC_URL`, the api's generated domain): point it at a
custom api domain too.

## Provision a tenant

There is no public route to the operator API. Run the call inside the control container, which holds `OPERATOR_TOKEN`:

```sh
railway ssh --service control -- node --input-type=module -e '
const r = await fetch("http://127.0.0.1:8081/v1/operator/tenants", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.OPERATOR_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ name: "acme", limits: { requestsPerMinute: 600, storageBytes: 1073741824 } }),
});
console.log(r.status, await r.text());'
```

`limits` is optional: an absent key takes the default (`maxConcurrentTurns` 4, `requestsPerMinute` 600 per api
process, `storageBytes` 1 GiB; ARCHITECTURE.md#tenancy). The response holds the tenant's API key once. Then
`curl https://<api domain>/v1/conversations -H "authorization: Bearer <key>" -d '{}'`. Tenant migrations fan out to every
tenant database during a release: `scripts/railway.ts deploy` calls `POST /v1/operator/migrate` inside the control
container after control rolls out and before the api, worker and console do, and stops the release if any tenant fails, so a
release that adds one needs no manual step. Run the call yourself (as above) to retry a failed tenant (the `migration
fan-out failed` alert). Code must tolerate schema versions n and n-1 while it runs.

## The console

People sign up at the console's domain ([ADR 0014](adr/0014-tenant-console.md)): each sign-up provisions a tenant exactly
as `POST /v1/operator/tenants` does (audited with actor `console`, default limits) and stores its first person, who sees
the tenant's first API key once. An operator can still provision by hand; such a tenant has no person and cannot be
signed in to. Suspending or deleting a tenant ends its console sessions at once (deleting also removes its people).
Sign-ups are limited per client address (`SIGNUPS_PER_HOUR`, 5) and failed sign-ins per address and per account
(`FAILED_LOGINS_PER_MINUTE` 10, `FAILED_LOGINS_PER_ACCOUNT_PER_HOUR` 20), per console process. There is no email
verification, password reset or second person per tenant yet (tech debt). To see who signed up:
`select email, tenant_id, created_at, last_login_at from console_users order by created_at` (psql below).

## Judgments

[ADR 0015](adr/0015-judgment-port.md), [ADR 0016](adr/0016-guardrails.md). A tenant stores a key for a judgment provider
(`PUT /v1/model-keys/typesafe` or `/opencode`, or the console's Model providers, which says what each key is for) and calls
`POST /v1/judgments`, or its agent calls the `judge` tool, or a conversation created with `guardrails` checks every message and
tool call. Only a `worker` calls a provider, so it needs outbound HTTPS to `api.typesafe.ai` and `opencode.ai`;
`TYPESAFE_BASE_URL` and `OPENCODE_SYSTEMONE_BASE_URL` on the worker point it elsewhere (stand-ins for local runs; unset in
production). An OpenCode key is the one key a tenant already uses for OpenCode chat models. A judgment is a task on the `turns`
queue: it counts against the tenant's `maxConcurrentTurns` and the worker's `MAX_RUNNING_TURNS`, and Absurd keeps its request
and outcome in the tenant's database for 30 days. Usage lands in the `usage` table as `<provider>/<served model>`
(`guardrail:...` rows for guardrail checks). A guardrail that cannot be checked fails closed, so a provider outage or a removed
key stops answers on those conversations: it shows as `the turn failed after 5 attempts` or `a guardrail could not be checked`
in the conversation's `lastError`. There is no alert; judgments `failed` after five attempts are
`select state, count(*) from absurd.t_turns where task_name = 'run-judgment' group by 1` in a tenant database.

## Events and webhooks

[ADR 0019](adr/0019-events-and-delivery.md), [ADR 0020](adr/0020-integrations-and-scopes.md). Every tenant starts with a
`default` integration holding every scope; its first key belongs to it, and so does a key an operator makes without naming
an integration (`POST /v1/operator/tenants/<id>/keys` takes `{ label?, integrationId? }`). People make further
integrations, their keys and their subscriptions in the console. A key polls with `GET /v1/events` (scope `events`); a
subscription is pushed by `dispatcher`, which needs outbound HTTPS to the whole internet (every request goes through the
egress guard, ADR 0010). `ALLOW_LOCAL_DESTINATIONS` (plain http and private addresses) is refused outside development:
never set it on Railway. A tenant may hold `limits.subscriptions` subscriptions (default 10, the api's
`DEFAULT_SUBSCRIPTIONS`) and run `limits.concurrentDeliveries` deliveries at once (default 4); the dispatcher runs at most
`MAX_RUNNING_DELIVERIES` (20) across tenants and scales with replicas. A delivery that keeps failing is retried 20 times
over about two and a half days; a subscription failing for 48 hours, or answered 410, is disabled, which the tenant sees
in the console and fixes by re-enabling it. That is the tenant's business, so there is no alert. Logs name the
subscription and the outcome, never the URL or the body: `make logs-query SERVICE=dispatcher TENANT=<id>`. Each tenant's
delivery log is `select * from delivery_attempts order by id desc` in its database. Control's nightly job deletes events
and attempts older than 30 days and Absurd's finished tasks past their queue's TTL.

## Export a tenant

`POST /v1/operator/tenants/<id>/export` (run as above) dumps the tenant's database and lists its objects into the
`kerby-exports` bucket and answers `{ dumpUrl, objectsUrl, expiresAt, ... }`: URLs that download without credentials for
24 hours, each recorded in the audit log (`export.url_issued`). Hand them over, or fetch them yourself before they expire.
Control deletes exports 30 days after they were made, a deleted tenant's too, at start and every night at 03:00 UTC.

To get fresh URLs for an export that exists (the URLs last 24 hours; the export stays 30 days, a deleted tenant's too),
without exporting again:

```sh
railway ssh --service control -- node --input-type=module -e '
const r = await fetch("http://127.0.0.1:8081/v1/operator/tenants/<id>/export/reissue", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.OPERATOR_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({}),  // {} picks the newest export; { stamp: "2026-11-22T03-00-00-000Z" } picks one
});
console.log(r.status, await r.text());
'
```

It answers `{ dumpUrl, objectsUrl, expiresAt, exportedAt, ... }` and audits each URL (`tenant.export_reissue`,
`export.url_issued`). 404 means the tenant has no export, or retention has deleted it.

## Bucket backup and restore

Every night at 03:00 UTC one control instance (a Postgres advisory lock picks it) copies every active or suspended tenant's
objects that are new or changed from `kerby` to `kerby-backup` (`sjc`), and deletes the copy of every tenant whose status is
`deleted`. Nothing else is deleted from the backup, so an object lost in `kerby` stays there. Railway buckets have no
versioning, replication or backups of their own. The run logs `bucket backup ran` with counts, bytes and its duration;
`failed` above zero raises the `bucket backup failed` alert. Run it now with `POST /v1/operator/backup` (409 while another run holds the lock).
Each run without a failing tenant is recorded in the audit log; control checks at start and every hour that one is less
than 26 hours old (with none recorded, that the process is) and raises `bucket backup overdue` if not. A control that is
down for the whole day cannot say so: it has no public domain, so only Railway's deployment webhook tells you.

Restore copies back only objects missing from `kerby`, never overwriting one, so it is safe to repeat while tenants work:

```sh
railway ssh --service control -- node --input-type=module -e '
const r = await fetch("http://127.0.0.1:8081/v1/operator/backup/restore", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.OPERATOR_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ tenantId: "<id>" }),  // {} restores every active or suspended tenant
});
console.log(r.status, await r.text());'
```

After a Postgres restore, restore every tenant (`{}`): the index the restored databases hold points at objects the bucket
may have lost since. Objects written after the last nightly run are not in the backup.

## Environments

`make railway-setup ENV=pr-123` creates `pr-123` as a copy of `production` (Railway gives the copy its own Postgres volume
and bucket), applies `.railway/railway.ts` to it, and replaces the secrets it inherited with ones of its own. Then
`GHCR_PULL_TOKEN=... make railway-registry ENV=pr-123` and `make deploy ENV=pr-123 TAG=sha-<commit>` (any commit CI built
on `main`); its api and console have their own Railway domains. `make env-down ENV=pr-123` deletes it with its data. `production` is never
deleted by `make`. CI does not make these: its token is scoped to `production` and cannot create environments (ADR 0011).

## Releasing

A merge to `main` is a release. CI (`.github/workflows/ci.yml`) runs `check` and `test`, builds the five images and pushes
them as `sha-<commit>`, then the `release` job: `railway config apply --yes` on production (a deletion fails here: review
it with `make railway-plan` and run `railway config apply` yourself), `scripts/railway.ts secrets` and `domains` (a secret
or public service the IaC file just added is created once, never replaced), `scripts/railway.ts registry`, and
`scripts/railway.ts deploy production sha-<commit>`, which moves each service's `production` tag and redeploys control,
then api, worker, dispatcher and console, waiting for each. When the IaC file adds a service, `config apply` creates it pointing at
an image tag that does not exist yet, so its first deployment fails (and the project webhook reports it) until `deploy`
moves the tag a minute later. Pull requests show the IaC plan in the `railway-plan` check. If a deployment fails,
read why with `railway logs --service <name>`; roll back with `make deploy TAG=sha-<previous commit>`.

CI needs two repository secrets, made once by a person:

- `RAILWAY_TOKEN`: project `kerby` → Settings → Tokens, scoped to `production`. Measured (plan 0003, C4): it can plan and
  apply the IaC, set registry credentials, redeploy, read logs, and read every variable and the bucket credentials of that
  environment (so all its secrets); it cannot create environments, list projects or make account queries. The CLI login
  cannot create one.
- `GHCR_PULL_TOKEN`: a classic GitHub token with `read:packages` only (https://github.com/settings/tokens/new?scopes=read:packages);
  Railway uses it to pull the private images.

Set both with `gh secret set <NAME> -R samchristensen/kerby`. Without them CI still publishes images and skips the release.
The `uptime` workflow runs every 15 minutes from GitHub: `GET /healthz` on the repository variable `KERBY_API_URL`, then
`GET /v1/conversations/<id>` as the `canary` tenant, which proves the key check, a tenant pool and the tenant database from
outside. The canary tenant (limits: 1 turn, 60 requests a minute, 1 MiB) holds one empty conversation (variable
`KERBY_CANARY_CONVERSATION_ID`) and a placeholder Anthropic key, because the api refuses a conversation without a model
key for its provider; it never posts, so nothing calls Anthropic. Its API key is the repository secret `KERBY_CANARY_KEY`.
To replace the key: create one for the tenant (`POST /v1/operator/tenants/<id>/keys`), `gh secret set KERBY_CANARY_KEY`,
revoke the old one. `nightly` runs `make e2e` and `make multitenant` on a fresh Compose stack.

## Secrets

Generated once by `railway-setup` (24 random bytes, hex; `TENANT_DB_KEYS` a base64 32-byte key), stored as service variables, readable with
`railway variable list --service control`: whoever can run that can read every secret. They are `preserve()` in the IaC file
on purpose: a generated value there would be made again on every apply.

- Each tenant database role has its own random password, stored in the control database sealed with `TENANT_DB_KEYS`
  ([ADR 0009](adr/0009-tenant-database-credentials.md)). The variable lives on `control`; `api` and `worker` reference it.
  Control gives a password to every tenant that has none stored at each start.
- **Rotate a tenant's database password**: `POST /v1/operator/tenants/<id>/rotate-db-password`, called inside the control
  container as under "Provision a tenant". Open sessions keep working; api and worker log in with the new password at their
  next connection (the old one is refused, they read the stored one again). No redeploy.
- **Rotate `TENANT_DB_KEYS`** in three redeploys (`make deploy TAG=sha-<the running commit>`: control, then api and
  worker), so no process ever meets a password it cannot open. Make a key with `make secrets-key`. (1) Set
  `TENANT_DB_KEYS=<old>,<new>` on `control` and redeploy: everyone opens both, `<old>` still seals. (2) Set `<new>,<old>`
  and redeploy: at start control seals every password again with `<new>` (its log line `tenant database passwords
  checked` counts them in `resealed`). (3) Set `<new>` and redeploy.
- **Lost `TENANT_DB_KEYS`**: nothing is stranded. Set a new key, delete every row of `tenant_db_credentials` (psql below,
  database `railway`), and redeploy: control gives every tenant a new password before api and worker start.
- Only `control` holds the administrative database URL. `api` and `worker` connect to the control database as the limited
  `kerby_app` role (migration 0002), the console as `kerby_console` (migration 0005); control creates both and gives them
  their passwords (`APP_DATABASE_PASSWORD`, `CONSOLE_DATABASE_PASSWORD`) at start: deploy control first.
- `CONSOLE_TOKEN` lives on `control`, and `console` references it: it opens control's sign-up route and nothing else. To
  rotate it, or `CONSOLE_DATABASE_PASSWORD`, set a new value on `control` and redeploy control, then console.
- The buckets' keys are references (`${{kerby.ACCESS_KEY_ID}}`), so resetting them needs no change here; redeploy the services.
  Only `control` references the keys of `kerby-exports` and `kerby-backup` (`EXPORT_S3_*`, `BACKUP_S3_*`).

## Postgres

- `max_connections` must be 550 (the template starts at 100). Set it once per environment, then restart Postgres (a
  restart drops every connection for a few seconds; the services reconnect):

  ```sh
  railway ssh --service control -- sh -c 'psql "$CLUSTER_ADMIN_URL" -c "alter system set max_connections = 550"'
  railway restart --service Postgres --yes
  railway ssh --service control -- sh -c 'psql "$CLUSTER_ADMIN_URL" -tAc "show max_connections"'   # 550
  ```

  `ALTER SYSTEM` writes `postgresql.auto.conf` on the volume, so the value survives restarts and redeploys. Neither the
  template nor `railway postgres` (only `pitr`, `ha`, `pgbouncer`) has a setting for it, and a custom start command
  (`-c max_connections=...`) would make the database ours to manage instead of Railway's. A new environment
  (`ENV=pr-123`) gets its own volume: check `show max_connections` there and run the same two commands if it says less.
- **Connection budget.** Every process opens at most (upper bounds, from the code's defaults):

  | Process    | Connections                             | Terms                                                                                                                                                                                                                                               |
  | ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | api        | `2 × max(maxPools, D + R) + D + 10`     | `maxPools` 50 tenant pools of 2; `D` tenants with an open event stream here (at most `MAX_STREAMS_PER_PROCESS`, 60), each also holding one shared `LISTEN` connection; `R` tenants with a request in flight; a control pool of 10                   |
  | worker     | `2 × max(maxPools, min(C, W)) + 10 + 1` | `C` turns at once across all tenants (`MAX_RUNNING_TURNS`, default 50); `W` tenants with a turn running or being claimed here, each holding its pool for as long as it does, so at most `C`; the control pool; one `LISTEN` on the control database |
  | control    | `2 × maxPools + 10 + 2 + 1`             | tenant pools (migration fan-out, exports, nightly retention); the control pool; the cluster admin's pool; one connection while provisioning                                                                                                         |
  | dispatcher | `2 × 20 + 5 + 1`                        | at most 20 tenant pools of 2 (`MAX_RUNNING_DELIVERIES` 20, and fan-out holds one tenant's pool at a time); a control pool of 5; one `LISTEN` on the control database                                                                                |
  | console    | `5`                                     | the control pool, as `kerby_console`; the console opens no tenant database                                                                                                                                                                          |

  The sum over all processes, plus `superuser_reserved_connections` (3) and room for operators' `psql` (say 17), must
  stay under `max_connections`. Today's shape (one of each, `R` up to 10): api 210 + worker 111 + control 113 + dispatcher
  46 + console 5 + 20 = 505 of 550 (500 sufficed before the dispatcher). Each extra worker adds 111, each extra dispatcher
  46 and each extra api 210: raise `max_connections` by as much first (and
  `TENANT_ROLE_CONNECTION_LIMIT`, below), or lower `MAX_STREAMS_PER_PROCESS` on the api. The worker's 111 holds at
  `MAX_RUNNING_TURNS` 50 however many tenants run at once: past the cap a worker claims nothing more and queues the
  tenants that ask, longest-waiting first. Raising it to `C` above 50 costs 2 connections per extra tenant, up to
  `2 × C + 11` for the worker: raise `max_connections` first.
- **Measured** (`make multitenant`, stream saturation, 2026-11-22; two api processes, 200 tenants provisioned, local
  `max_connections` 500): an open stream costs its tenant 3 connections on that api process (the pool of 2 and the
  listener) however many streams it has: 46 tenants with 60 streams held 156 connections on one process, 60 tenants
  with one stream each 181 to 183 on the other (the bound above: 190). Peak 421 to 426 client connections in all
  (worker 61, control 23 to 26). One tenant role peaked at 8 (3 per api process and 2 from the worker). Postgres used
  0.8 to 1.2 GiB with about 420 connections and up to 202 databases.
- **Caps**, set from those numbers: `MAX_STREAMS_PER_PROCESS` 60 (503 `server_busy` past it) keeps one api process's
  worst case at 210; `MAX_STREAMS_PER_TENANT` 15 (429 `too_many_streams`), a quarter of that, so one tenant cannot take
  a whole process (its own streams cost nothing more); `TENANT_ROLE_CONNECTION_LIMIT` 20 per tenant role, from 3 per api
  process, 2 per worker, 2 per dispatcher and 3 from control (pool and `pg_dump`): enough for 3 api, 2 workers and 1
  dispatcher, or 2 of each. A role made before a change gets the new limit at the next `POST /v1/operator/migrate`.
- **PgBouncer** (`railway postgres pgbouncer`) is not used. Transaction pooling breaks `LISTEN`, which event streams and
  the worker's scheduler rely on, and Railway repoints every service referencing the database's variables to the
  pooler; session pooling saves nothing, since Kerby's connections are long-lived pools already; and PgBouncer pools per
  user and database, which is per tenant here. Revisit when the budget outgrows one Postgres's memory: transaction
  pooling for tenant pools only, with `LISTEN` and control on `DATABASE_UNPOOLED_URL`.
- About 1 GiB of memory per 200 tenant databases was measured locally.
- Backups: a daily backup of the Postgres volume, kept 6 days (`railway postgres pitr schedule list --service Postgres`;
  set with `railway postgres pitr schedule set --daily`). Restore: `railway postgres pitr backup list`, then
  `railway postgres pitr backup restore <id> --service Postgres` (replaces the volume's contents: take an on-demand backup
  first with `railway postgres pitr backup create`). The restore drill took 77 s on a small database (ADR 0012). Bucket
  objects are not in it: see the bucket backup.
- psql into production: `railway ssh --service control -- sh -c 'psql "$CLUSTER_ADMIN_URL"'` (the control image has the client).

## Cost

Railway bills by use: CPU and memory of running containers, volume size, bucket storage and network egress. Nothing sleeps
(ADR 0007), so the floor is Postgres plus four small services running all month; see the project's usage page for the
real figure rather than an estimate here.

## Observing

`railway logs --service <name>` (add `--lines N`), `railway metrics --service <name> --since 1h`. Logs are JSON with
`tenantId` and never message content: a `request` line per API request (status 429 for a tenant over its request
rate), `turn completed`, `turn failed for good`, `judgment completed` (outcome `answered` or `refused`, question count, duration), `history cut to its budget` (a turn started without its oldest turns).
`api` and `console` run with `TRUST_PROXY=true`: Railway's edge sets `X-Forwarded-For` with the client first, and the
failed-auth limit (api) and the sign-up and sign-in limits (console) count that address; without it every client would
share the proxy's. The console logs `console sign-up` (tenant id and person id, never the email) and `request failed`;
Next.js prints a few plain-text lines at start.
`make logs-query ENV=production` reads them and keeps the lines that match `TENANT=<id>`, `LEVEL=warn` (that level and
worse), `MSG=<substring>`, `SERVICE=<control|api|worker|console>`, `SINCE=`/`UNTIL=` (`30m`, `2h`, `1d` back from now, or ISO
8601; Railway's default here is the last hour), one JSON line each, oldest first. Run it from a checkout linked with
`railway link`; Railway serves the current deployment's logs this way, older ones are in the dashboard. Without `ENV`
it reads the local stack. An alert's `msg` is its kind (below), so `MSG='turn failed'` finds those too.

## Alerts

Everything goes to one channel (a Slack or Discord channel the operator watches):

1. **Railway notifications** (workspace settings, Notifications): email and in-app, on by default for build failures,
   crashed deployments, OOM kills and volume usage. Keep them on.
2. **One project webhook** (project settings, Webhooks) to the channel's incoming-webhook URL: deployment status changes
   (`Deployment.failed`, `Deployment.crashed`, `Deployment.oom_killed`), volume usage alerts and monitor alerts. Railway
   formats Slack and Discord URLs itself. The webhook is unsigned. There is no CLI command; the GraphQL mutation
   `notificationRuleCreate` (`railway api`) creates one with `channelConfigs: [{type: "webhook", url}]`.
3. **Monitors** (Pro plan; per service in the dashboard): CPU, RAM, disk and egress thresholds, alerting through the
   webhook.
4. **`ALERT_WEBHOOK_URL`** on `control`, `api` and `worker`, the same channel URL: Railway cannot alert on log lines, so
   Kerby posts its own failures. `alert(kind, fields)` (`@kerby/observability`) writes an error line with
   `alert: <kind>` and posts it: `turn failed for good` and `lease lost` (worker), `provisioning failed`,
   `migration fan-out failed`, `bucket backup failed`, `bucket backup overdue`, `bucket backup freshness check failed` and `export retention failed` (control). A Slack URL (`hooks.slack.com`) gets `{"text"}`, Discord
   (`discord.com/api/webhooks`) `{"content"}`, anything else the alert as JSON (`alert`, `service`, `environment`,
   `at`, `tenantId`, `fields`, `suppressed`). One post per kind per process per five minutes; the next post counts the
   ones held back, and every one is still a log line (`make logs-query ENV=production LEVEL=error`). Posts carry tenant
   ids and error names, never content or secrets; a failed post is logged (`alert post failed`) and never breaks the
   caller. Unset, alerts are log lines only.

The URL is a secret (whoever has it can post to the channel). It is `preserve()` in the IaC file, so set it per
environment; setting a variable redeploys the service with the image it already runs:

```sh
for s in control api worker; do
  printf %s "$URL" | railway variable set ALERT_WEBHOOK_URL --stdin --service $s --environment production
done
```

A copy made by `make railway-setup ENV=pr-123` inherits production's value; its posts name the environment
(`kerby worker (pr-123): ...`, from Railway's `RAILWAY_ENVIRONMENT_NAME`). Remove it there with
`railway variable delete ALERT_WEBHOOK_URL --service <s> --environment pr-123` if the channel should stay quiet.
Locally, `KERBY_ALERT_WEBHOOK_URL=http://host.docker.internal:<port>/ make up` posts to a listener on your machine.

Production (2026-11-22): a Slack app with an incoming webhook into the alerts channel; the same URL is
`ALERT_WEBHOOK_URL` on all three services, the project webhook, and the repository secret `ALERT_WEBHOOK_URL` that the
`uptime` workflow posts to on failure. The Monitors were added by hand in the dashboard (they are not in the IaC file).

## Do not do

- Do not replace `TENANT_DB_KEYS` in one step on a live system: add the new key first (Secrets, above).
- Do not give `control` a public domain, or the console the operator token or the administrative database URL.
- Do not delete `production` or its Postgres volume: backups belong to the volume.
- Do not push a new service's first image to GHCR by hand (for a trial environment, say): the package is then created
  without a link to the repository, and CI's pushes to it are refused (`denied: permission_denied: read_package`). Let
  CI's `images` job create it. If it happened: delete the package (`gh api -X DELETE
  /users/samchristensen/packages/container/kerby-<service>`) and re-run the failed jobs.

## Known gaps

See `docs/plans/tech-debt.md`. Known and accepted (ADR 0012): one Postgres instance, up to a day of data lost to a volume
failure.
