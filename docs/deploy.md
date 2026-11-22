# Deploying to Railway

What `.railway/railway.ts` (Railway Infrastructure as Code), CI (`.github/workflows/ci.yml`) and `scripts/railway.ts` create,
and how to run them. Why: [ADR 0007](adr/0007-railway-hosting.md), [ADR 0011](adr/0011-images-from-ghcr.md). Status:
deployed and smoke-tested on a real project (plan 0001 log, 2026-11-22).

## What exists

One Railway project, `kerby`. Per environment (`production` is the standing one):

| Service        | What                                                                                                 | Reachable from                           |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Postgres`     | Railway's PostgreSQL template (18) on a volume; holds the control database and every tenant database | the other services, privately            |
| bucket `kerby` | Railway bucket (S3-compatible); every object is under `t/<tenantId>/`                                | the other services, by endpoint and keys |
| `control`      | operator API (`:8081`), no public domain                                                             | `railway ssh --service control`          |
| `api`          | tenant API (`:8080`), public Railway domain                                                          | the internet                             |
| `worker`       | runs turns, health on `:8082`, no public domain                                                      | nothing                                  |

`control`, `api` and `worker` run the images CI builds from `services/<name>/Dockerfile` (stage `prod`) and pushes to GHCR
(`ghcr.io/samchristensen/kerby-<name>`); Railway builds nothing. Each environment runs the tag named after it
(`kerby-api:production`); a release moves that tag. Services are health-checked on `/healthz`. Postgres is reached at
`postgres.railway.internal` on the private network, without TLS.

## First time

You need the Railway CLI (5.42.1 or newer), signed in (`railway login`), Node (the scripts run TypeScript directly), and
Docker logged in to GHCR with a token that can push (`gh auth token | docker login ghcr.io -u <user> --password-stdin`).

```sh
railway init --name kerby                  # creates the project and links this checkout to it
make railway-plan                          # preview: what .railway/railway.ts would change
make railway-setup                         # apply it, add api's domain, create the secrets once
GHCR_PULL_TOKEN=... make railway-registry  # let the services pull the private images (classic token, read:packages)
make deploy TAG=sha-<commit>               # a commit CI built: control first, then api and worker; waits for SUCCESS
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
a key rotation (ADR 0008), update the copy.

The api's address is in `railway service list --json` (`url`). A custom domain: add `domains: ["api.example.com"]` to the
`api` service in `.railway/railway.ts` and apply, then add the DNS records Railway prints.

## Provision a tenant

There is no public route to the operator API. Run the call inside the control container, which holds `OPERATOR_TOKEN`:

```sh
railway ssh --service control -- node --input-type=module -e '
const r = await fetch("http://127.0.0.1:8081/v1/operator/tenants", {
  method: "POST",
  headers: { authorization: "Bearer " + process.env.OPERATOR_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ name: "acme" }),
});
console.log(r.status, await r.text());'
```

The response holds the tenant's API key once. Then
`curl https://<api domain>/v1/conversations -H "authorization: Bearer <key>" -d '{}'`. After a release that adds tenant
migrations, fan them out with `POST /v1/operator/migrate` the same way: code must tolerate schema versions n and n-1
while it runs.

## Environments

`make railway-setup ENV=pr-123` creates `pr-123` as a copy of `production` (Railway gives the copy its own Postgres volume
and bucket), applies `.railway/railway.ts` to it, and replaces the secrets it inherited with ones of its own. Then
`GHCR_PULL_TOKEN=... make railway-registry ENV=pr-123` and `make deploy ENV=pr-123 TAG=sha-<commit>` (any commit CI built
on `main`); its api has its own Railway domain. `make env-down ENV=pr-123` deletes it with its data. `production` is never
deleted by `make`. CI does not make these: its token is scoped to `production` and cannot create environments (ADR 0011).

## Releasing

A merge to `main` is a release. CI (`.github/workflows/ci.yml`) runs `check` and `test`, builds the three images and pushes
them as `sha-<commit>`, then the `release` job: `railway config apply --yes` on production (a deletion fails here: review
it with `make railway-plan` and run `railway config apply` yourself), `scripts/railway.ts registry`, and
`scripts/railway.ts deploy production sha-<commit>`, which moves each service's `production` tag and redeploys control,
then api and worker, waiting for each. Pull requests show the IaC plan in the `railway-plan` check. If a deployment fails,
read why with `railway logs --service <name>`; roll back with `make deploy TAG=sha-<previous commit>`.

CI needs two repository secrets, made once by a person:

- `RAILWAY_TOKEN`: project `kerby` → Settings → Tokens, scoped to `production`. It can plan, apply and deploy that one
  environment and read its variables (so its secrets). The CLI login cannot create one.
- `GHCR_PULL_TOKEN`: a classic GitHub token with `read:packages` only (https://github.com/settings/tokens/new?scopes=read:packages);
  Railway uses it to pull the private images.

Set both with `gh secret set <NAME> -R samchristensen/kerby`. Without them CI still publishes images and skips the release.
The `uptime` workflow checks `GET /healthz` on the repository variable `KERBY_API_URL` every 15 minutes; `nightly` runs
`make e2e` and `make multitenant` on a fresh Compose stack.

## Secrets

Generated once by `railway-setup` (24 random bytes, hex), stored as service variables, readable with
`railway variable list --service control`: whoever can run that can read every secret. They are `preserve()` in the IaC file
on purpose: a generated value there would be made again on every apply.

- Do not change `TENANT_DB_SECRET`: every tenant role's password derives from it, so every tenant would be locked out
  of its database until each role's password is reset.
- Only `control` holds the administrative database URL. `api` and `worker` connect to the control database as the limited
  `kerby_app` role, which control creates (migration 0002) and gives its password at start: deploy control first.
- The bucket's keys are references (`${{kerby.ACCESS_KEY_ID}}`), so resetting them needs no change here; redeploy the services.

## Postgres

- `max_connections` is 100 (the template's default). Each api or worker process may hold up to 50 tenant pools of 2
  connections, plus one connection per open event stream. Keep the sum well below the limit, and raise it before the
  tenant count grows: `ALTER SYSTEM SET max_connections = ...` and a restart, run by you from `railway ssh --service Postgres`.
- About 1 GiB of memory per 200 tenant databases was measured locally.
- Backups: a daily backup of the Postgres volume, kept 6 days (`railway postgres pitr schedule list --service Postgres`;
  set with `railway postgres pitr schedule set --daily`). Restore: `railway postgres pitr backup list`, then
  `railway postgres pitr backup restore <id> --service Postgres` (replaces the volume's contents: take an on-demand backup
  first with `railway postgres pitr backup create`). The restore drill took 77 s on a small database (ADR 0012). Bucket
  objects are not in it: see the bucket backup.
- psql into production: `railway ssh --service control -- sh -c 'psql "$CLUSTER_ADMIN_URL"'` (the control image has the client).

## Cost

Railway bills by use: CPU and memory of running containers, volume size, bucket storage and network egress. Nothing sleeps
(ADR 0007), so the floor is Postgres plus three small services running all month; see the project's usage page for the
real figure rather than an estimate here.

## Observing

`railway logs --service <name>` (add `--lines N`), `railway metrics --service <name> --since 1h`. Logs are JSON with
`tenantId` and never message content: a `request` line per API request, `turn completed`, `turn failed for good`.
`make logs-query ENV=production` reads them and keeps the lines that match `TENANT=<id>`, `LEVEL=warn` (that level and
worse), `MSG=<substring>`, `SERVICE=<control|api|worker>`, `SINCE=`/`UNTIL=` (`30m`, `2h`, `1d` back from now, or ISO
8601; Railway's default here is the last hour), one JSON line each, oldest first. Run it from a checkout linked with
`railway link`; Railway serves the current deployment's logs this way, older ones are in the dashboard. Without `ENV`
it reads the local stack. An alert's `msg` is its kind (below), so `MSG='turn failed'` finds those too.

## Alerts

Everything goes to one channel (a Slack or Discord channel the operator watches):

1. **Railway notifications** (workspace settings, Notifications): email and in-app, on by default for build failures,
   crashed deployments, OOM kills and volume usage. Keep them on.
2. **One project webhook** (project settings, Webhooks) to the channel's incoming-webhook URL: deployment status changes
   (`Deployment.failed`, `Deployment.crashed`), volume usage alerts and monitor alerts. Railway formats Slack and Discord
   URLs itself. The webhook is unsigned.
3. **Monitors** (Pro plan; per service in the dashboard): CPU, RAM, disk and egress thresholds, alerting through the
   webhook.
4. **`ALERT_WEBHOOK_URL`** on `control`, `api` and `worker`, the same channel URL: Railway cannot alert on log lines, so
   Kerby posts its own failures. `alert(kind, fields)` (`@kerby/observability`) writes an error line with
   `alert: <kind>` and posts it: `turn failed for good` and `lease lost` (worker), `provisioning failed` and
   `migration fan-out failed` (control). A Slack URL (`hooks.slack.com`) gets `{"text"}`, Discord
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

## Do not do

- Do not change `TENANT_DB_SECRET` on a live system.
- Do not give `control` a public domain.
- Do not delete `production` or its Postgres volume: backups belong to the volume.

## Known gaps

See `docs/plans/tech-debt.md`. Known and accepted (ADR 0012): one Postgres instance, up to a day of data lost to a volume
failure.
