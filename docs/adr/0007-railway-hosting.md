# 0007. Hosting: Railway (Postgres, a bucket, three services)

- Status: proposed
- Date: 2026-11-22

## Context

Plan 0001 left the hosting target open. A first design on a hyperscaler (load balancer, a serverless Postgres, container
services, Terraform in three stacks, about 40 alarms, a Lambda to scale to zero) was written and validated but never
applied; its idle floor was dominated by the load balancer and its surface was far larger than three stateless services
and one Postgres need. The same images run locally (Compose) and hosted, so hosting must need nothing they do not
already do.

## Decision

- **Railway**, one project `kerby`, one standing environment `production`. Any other environment is a name
  (`make railway-setup ENV=pr-123`) and is removed with `make env-down ENV=pr-123`.
- **Four services per environment.** `Postgres` (Railway's PostgreSQL template: a `postgres-ssl` image on a volume),
  and `control`, `api`, `worker`, each running the image CI builds from its own `services/<name>/Dockerfile` (the last
  stage, `prod`) and pushes to GHCR ([ADR 0011](0011-images-from-ghcr.md), which replaced Railway building what `railway up`
  uploaded). `make deploy` deploys control first (it creates the limited `kerby_app` role that api and worker connect as),
  then the other two.
- **One bucket per environment for tenant data**, a Railway bucket (S3-compatible, `@kerby/blobs` unchanged). `S3_*` on each
  service are references to the bucket's variables. Keys stay under `t/<tenantId>/`. Two more buckets, exports and a backup
  copy, are `control`'s alone ([ADR 0013](0013-exports-and-bucket-backup.md)).
- **Networking.** Only `api` has a public domain. `control` (the operator API) and `worker` have none: operators reach
  control with `railway ssh`. Services reach Postgres over Railway's private network, which does not use TLS, so
  `TENANT_DB_SSLMODE` stays unset.
- **Postgres.** The control database is the template's `railway` database. Control's administrative URL is the `postgres`
  superuser; provisioning relies on it (no path for a non-superuser admin is kept). Postgres 18 is
  what the template ships, so Compose, the test containers and `pg_dump` in the control image are 18 too.
- **Secrets** are generated once by the setup script (24 random bytes, hex), stored as service variables, and kept on
  every later run. `TENANT_DB_KEYS` ([ADR 0009](0009-tenant-database-credentials.md), a base64 32-byte key) is made once
  the same way on `control`, which api and worker reference; it is rotated by the runbook in deploy.md, never by regenerating it.
  The secrets key pair ([ADR 0008](0008-byok-sealed-secrets.md)) is made once the same way: the private key on `worker`, the public
  key on `api`. Kerby holds no model provider keys: tenants bring theirs.
- **Infrastructure is Railway Infrastructure as Code** ([`.railway/railway.ts`](../../.railway/railway.ts), the `railway` SDK pinned
  in the catalog): the database, its volume, the bucket, the three services (image sources, health checks) and every
  variable, with references between them. `make railway-plan` previews and `make railway-setup` applies it (the Railway CLI
  compares the file with the environment and shows the diff first; deletions need a person). One file describes every environment.
- **What the file leaves to `scripts/railway.ts`.** Secrets: a generated variable (`${{secret(n)}}`) is made again on every
  apply (verified), which would rotate `TENANT_DB_KEYS` and `SECRETS_PRIVATE_KEYS`, so they are `preserve()` and the script creates each once and
  never replaces it. The api's generated domain (the IaC does not manage generated domains). Code: each service's source is
  the GHCR image tagged with the environment's name, which `make deploy` moves (ADR 0011). A new environment: a copy of production (`environment new --duplicate`),
  because an empty environment filled in by the file never gets its bucket deployed (verified); the script then replaces the
  secrets the copy inherited.
- Rejected: Terraform (a third-party Railway provider plus a state backend); an imperative script alone (what this replaced:
  drift between what the script made and what Railway held, and no preview); Git-connected auto-deploys (no remote yet).

## Consequences

- Always on: no scale to zero. Railway bills usage (CPU, memory, volume, egress), so small idle services cost little;
  nothing sleeps ([ADR 0012](0012-recovery-and-availability.md)).
- One Postgres instance on one volume: no replica, no multi-zone storage; nightly volume backups and the HA trigger are
  in [ADR 0012](0012-recovery-and-availability.md).
- Alerts are Railway's notifications, one project webhook and monitors, plus Kerby's own failures posted to
  `ALERT_WEBHOOK_URL`, all into one channel (docs/deploy.md#alerts). No dashboards beyond Railway's metrics. Logs are
  structured JSON with tenant ids and no content (`make logs-query`).
- Whoever holds the Railway login can read every variable, so every secret. There is no least-privilege agent role yet
  (tech debt): a project token (`RAILWAY_TOKEN`) is the starting point.
- Not yet exercised here: Postgres `max_connections` at the template's default against the budget in docs/deploy.md.
