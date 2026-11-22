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
  and `control`, `api`, `worker`, each built by Railway from its own `services/<name>/Dockerfile` (the last stage, `prod`)
  and uploaded with `railway up`; there is no Git connection, so a deploy is what is on disk. `make deploy` deploys
  control first (it creates the limited `kerby_app` role that api and worker connect as), then the other two.
- **One bucket per environment**, a Railway bucket (S3-compatible, `@kerby/blobs` unchanged). The setup script copies its
  endpoint and keys into `S3_*` variables on each service. Keys stay under `t/<tenantId>/`.
- **Networking.** Only `api` has a public domain. `control` (the operator API) and `worker` have none: operators reach
  control with `railway ssh`. Services reach Postgres over Railway's private network, which does not use TLS, so
  `TENANT_DB_SSLMODE` stays unset.
- **Postgres.** The control database is the template's `railway` database. The `postgres` role is a superuser, so the
  provisioning path for a non-superuser admin is unused here (kept, and tested, for hosts that give none). Postgres 18 is
  what the template ships, so Compose, the test containers and `pg_dump` in the control image are 18 too.
- **Secrets** are generated once by the setup script (24 random bytes, hex), stored as service variables, and kept on
  every later run. `TENANT_DB_SECRET` is never regenerated on a live system: every tenant role's password derives from it.
  The secrets key pair ([ADR 0008](0008-byok-sealed-secrets.md)) is made once the same way: the private key on `worker`, the public
  key on `api`. Kerby holds no model provider keys: tenants bring theirs.
- **Provisioning is a script, not declarative state.** `scripts/railway.ts` (`setup`, `deploy`) drives the CLI and is safe
  to run again. Rejected: Terraform (a third-party Railway provider plus a state backend to hold four services and their
  passwords is more than 250 lines of script); Git-connected auto-deploys (needs a remote the repo does not have yet).

## Consequences

- Always on: no scale to zero. Railway bills usage (CPU, memory, volume, egress), so small idle services cost little;
  `deploy.sleepApplication` could put `api` to sleep but is untested with event streams and the worker never idles.
- One Postgres instance on one volume: no replica, no multi-zone storage. Backups are not configured (tech debt).
- No alarms or dashboards beyond Railway's logs and metrics (tech debt). Logs are structured JSON with tenant ids and no content.
- Whoever holds the Railway login can read every variable, so every secret. There is no least-privilege agent role yet
  (tech debt): a project token (`RAILWAY_TOKEN`) is the starting point.
- Tenant exports are written to the control container's disk, which a redeploy clears (tech debt, as before).
- Not yet exercised here: Postgres `max_connections` at the template's default against the budget in docs/deploy.md.
