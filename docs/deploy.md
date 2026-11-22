# Deploying to Railway

What `.railway/railway.ts` (Railway Infrastructure as Code) and `scripts/railway.ts` create, and how to run them. Why: [ADR 0007](adr/0007-railway-hosting.md). Status: deployed and
smoke-tested on a real project (plan 0001 log, 2026-11-22).

## What exists

One Railway project, `kerby`. Per environment (`production` is the standing one):

| Service        | What                                                                                                 | Reachable from                           |
| -------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Postgres`     | Railway's PostgreSQL template (18) on a volume; holds the control database and every tenant database | the other services, privately            |
| bucket `kerby` | Railway bucket (S3-compatible); every object is under `t/<tenantId>/`                                | the other services, by endpoint and keys |
| `control`      | operator API (`:8081`), no public domain                                                             | `railway ssh --service control`          |
| `api`          | tenant API (`:8080`), public Railway domain                                                          | the internet                             |
| `worker`       | runs turns, health on `:8082`, no public domain                                                      | nothing                                  |

`control`, `api` and `worker` are built by Railway from `services/<name>/Dockerfile` (its last stage, `prod`) and
health-checked on `/healthz`. Postgres is reached at `postgres.railway.internal` on the private network, without TLS.

## First time

You need the Railway CLI (5.42.1 or newer), signed in (`railway login`), and Node (the scripts run TypeScript directly).

```sh
railway init --name kerby                  # creates the project and links this checkout to it
make railway-plan                          # preview: what .railway/railway.ts would change
make railway-setup                         # apply it, add api's domain, create the secrets once
make deploy                                # control first, then api and worker; waits for each to report SUCCESS
```

The infrastructure lives in [`.railway/railway.ts`](../.railway/railway.ts): edit it, `make railway-plan`, then `make
railway-setup`. The CLI shows the diff and applies it; a deletion (a service, a variable) is refused without a person
confirming it, so run `railway config apply` yourself for those. Do not change infrastructure in the dashboard: the next plan
shows it as drift, and `railway config pull` imports it if you did. `railway-setup` is safe to run again; it never replaces
a secret. Kerby holds no model provider keys: each tenant
stores its own (`PUT /v1/model-keys/<provider>`, [ADR 0008](adr/0008-byok-sealed-secrets.md)). The setup makes a secrets key
pair once: the private key is `SECRETS_PRIVATE_KEYS` on `worker`, the public half `SECRETS_PUBLIC_KEY` on `api`. Never delete
the private key from `worker`: every stored tenant key is sealed to it. Back it up somewhere other than Railway.

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
and bucket), applies `.railway/railway.ts` to it, and replaces the secrets it inherited with ones of its own. `make deploy ENV=pr-123`
deploys to it; its api has its own Railway domain. `make env-down ENV=pr-123` deletes it with its data. `production` is
never deleted by `make`.

## Deploying a change

`make deploy` uploads the working tree (`railway up`; gitignored files are left out) and records the commit, with `+dirty`
when the tree is not clean. There is no Git connection: what is on disk is what ships. If a deployment fails, read why
with `railway logs --service <name>`.

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
- Backups are not configured yet (tech debt). Until they are, treat the volume as the only copy.
- psql into production: `railway ssh --service control -- sh -c 'psql "$CLUSTER_ADMIN_URL"'` (the control image has the client).

## Cost

Railway bills by use: CPU and memory of running containers, volume size, bucket storage and network egress. Nothing sleeps
(ADR 0007), so the floor is Postgres plus three small services running all month; see the project's usage page for the
real figure rather than an estimate here.

## Observing

`railway logs --service <name>` (add `--lines N`), `railway metrics --service <name> --since 1h`. Logs are JSON with
`tenantId` and never message content: a `request` line per API request, `turn completed`, `turn failed for good`.
There are no alarms yet (tech debt).

## Do not do

- Do not change `TENANT_DB_SECRET` on a live system.
- Do not give `control` a public domain.
- Do not delete `production` or its Postgres volume: there is no backup.

## Known gaps

See `docs/plans/tech-debt.md`: no backups, no alarms, a single Postgres instance, `max_connections` at 100, no edge rate
limiting, every tenant role's password derives from one shared secret, tenant exports are written to the control
container's disk.
