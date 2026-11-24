# Deploying Kerby

Kerby runs as one install per project: one tenant, one owner (ADR [0024](adr/0024-self-hosted-single-tenant.md)). An
install is two images CI publishes on every merge to `main`, plus a Postgres and a bucket of its own:

| Container     | Image                                  | Runs                                                                                | Port                             |
| ------------- | -------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| `kerby`       | `ghcr.io/samchristensen/kerby`         | the launcher, which starts control, then api, worker and dispatcher (`KERBY_ROLES`) | 8080, the api                    |
| `console`     | `ghcr.io/samchristensen/kerby-console` | the console, optional: sign in as the configured admin                              | 3000                             |
| Postgres      | Postgres 18 with pgvector              | the control database, the tenant's database, the template it was copied from        | 5432, never shared with your app |
| S3-compatible | a Railway bucket, or RustFS locally    | message bodies and traces under `t/<tenantId>/`                                     |                                  |

Tags: `main` (the newest merge) and `sha-<commit>` (pin one). On start, control migrates every database, makes the
tenant if there is none, and keeps the configured API key and console admin as config says; the other processes start
once it is ready. Upgrading is pulling a newer image and restarting: code tolerates the schema one release back, so a
second `KERBY_ROLES=worker` container may run the old image for a minute.

## Secrets and settings

`make secrets-key` prints the two values to generate:

- **`KERBY_SECRET_KEY`** (32 bytes, base64): every other key derives from it (the sealed model keys and tool credentials,
  the tenant database password's seal, the webhook signing secrets' seal, the limited roles' passwords). Keep a copy
  outside the host: without it, a restored database opens none of its model keys or credentials. It cannot be rotated
  yet (plan 0007, "Not in this plan").
- **`KERBY_API_KEY`** (`kb_<id>_<secret>`): the tenant's key with every scope, made by control at start. Your application
  uses the same value. Change it and restart: the new key works and the old one is revoked. A key revoked in the
  console comes back at the next start, since config holds it.

| Variable                                                                            | On             | What                                                                                                                                 |
| ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `KERBY_SECRET_KEY`                                                                  | kerby, console | above                                                                                                                                |
| `DATABASE_URL`                                                                      | kerby, console | Kerby's own Postgres as its superuser; its database is the control database. The processes connect as limited roles derived from it. |
| `KERBY_API_KEY`                                                                     | kerby          | above; or leave it unset and make keys in the console                                                                                |
| `KERBY_ADMIN_EMAIL`, `KERBY_ADMIN_PASSWORD`                                         | kerby          | the console's one account; a changed password replaces the old, a changed email replaces the account                                 |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | kerby          | the bucket; control creates it if missing                                                                                            |
| `DEFAULT_MODEL`                                                                     | kerby          | `<provider>/<model>` for a conversation that names none; add the provider's key in the console or `PUT /v1/model-keys/<provider>`    |
| `EGRESS_ALLOWED_HOSTS`, `ALLOW_LOCAL_DESTINATIONS`                                  | kerby          | your own private services, below                                                                                                     |
| `HOST`, `PORT`                                                                      | kerby          | where the api listens (8080); `::` on Railway, whose private network is IPv6                                                         |
| `TRUST_PROXY`                                                                       | kerby, console | `true` behind Railway's edge, so the failed sign-in and request limits count the client's address                                    |
| `API_URL`, `API_PUBLIC_URL`, `PUBLIC_URL`                                           | console        | the api inside the network, the api's public address (shown in the quickstart), the console's own address                            |
| `CONSOLE_PUBLIC_URL`                                                                | kerby          | the console's `PUBLIC_URL`: tool servers connected with OAuth redirect there (ADR 0022)                                              |
| `ALERT_WEBHOOK_URL`                                                                 | kerby          | [Alerts](#alerts)                                                                                                                    |
| `KERBY_ROLES`                                                                       | kerby          | `control,api,worker,dispatcher` by default; `worker` for an extra worker container. One container per install runs `control`.        |

Every other setting a service reads (`ARCHITECTURE.md`, each `services/*/src/config`) may be set on `kerby` too; the
launcher passes the environment through and overrides only what it derives. Files under `KERBY_SECRETS_DIR` (or
`/run/secrets`) work for any of them.

## Beside a project, with Compose

The repository's `compose.yaml` is the development stack (`make up`). In another project, add Kerby from the images
(log in to GHCR first if the packages are private: `docker login ghcr.io` with a token holding `read:packages`):

```yaml
services:
  kerby-postgres:
    image: pgvector/pgvector:0.8.7-pg18-trixie
    environment: { POSTGRES_PASSWORD: change-me, POSTGRES_DB: kerby }
    volumes: [kerby-pgdata:/var/lib/postgresql]
    healthcheck:
      { test: ["CMD-SHELL", "pg_isready -U postgres -d kerby"], interval: 3s, retries: 20 }
  kerby-s3:
    image: rustfs/rustfs:1.0.6
    command: ["/data"]
    environment: { RUSTFS_ACCESS_KEY: kerby, RUSTFS_SECRET_KEY: change-me-too }
    volumes: [kerby-s3data:/data]
  kerby:
    image: ghcr.io/samchristensen/kerby:main
    restart: unless-stopped
    environment:
      KERBY_SECRET_KEY: ${KERBY_SECRET_KEY}
      KERBY_API_KEY: ${KERBY_API_KEY}
      DATABASE_URL: postgres://postgres:change-me@kerby-postgres:5432/kerby
      S3_ENDPOINT: http://kerby-s3:9000
      S3_BUCKET: kerby
      S3_ACCESS_KEY_ID: kerby
      S3_SECRET_ACCESS_KEY: change-me-too
      DEFAULT_MODEL: anthropic/claude-sonnet-4-5
      # Tools and webhooks served by this project (below).
      EGRESS_ALLOWED_HOSTS: app
      ALLOW_LOCAL_DESTINATIONS: "true"
    depends_on:
      kerby-postgres: { condition: service_healthy }
      kerby-s3: { condition: service_started }
volumes:
  kerby-pgdata:
  kerby-s3data:
```

The application calls `http://kerby:8080` with `KERBY_API_KEY` (`new Kerby({ apiKey, baseUrl })`,
`packages/sdk/INTEGRATION.md`). Add the console like the repository's `compose.yaml` does, with `API_URL:
http://kerby:8080`, if you want it.

## Inside a Railway project

Add to the application's project (the dashboard, or `railway add`):

1. **Postgres** for Kerby alone, image `ghcr.io/railwayapp-templates/postgres-ssl:18` (it ships pgvector), named
   `kerby-postgres`. Turn on its volume's backups (Backups, below).
2. **A bucket**, named `kerby-bucket`.
3. **`kerby`**, from the image `ghcr.io/samchristensen/kerby:main` (private packages: give the service a GHCR token with
   `read:packages` under its registry credentials), or from this repository with `RAILWAY_DOCKERFILE_PATH=services/kerby/Dockerfile`.
   Healthcheck path `/healthz`. Variables:

   ```
   KERBY_SECRET_KEY=<make secrets-key>
   KERBY_API_KEY=<make secrets-key>
   DATABASE_URL=${{kerby-postgres.DATABASE_URL}}
   S3_ENDPOINT=${{kerby-bucket.ENDPOINT}}
   S3_REGION=${{kerby-bucket.REGION}}
   S3_BUCKET=${{kerby-bucket.BUCKET}}
   S3_ACCESS_KEY_ID=${{kerby-bucket.ACCESS_KEY_ID}}
   S3_SECRET_ACCESS_KEY=${{kerby-bucket.SECRET_ACCESS_KEY}}
   HOST=::
   PORT=8080
   TRUST_PROXY=true
   DEFAULT_MODEL=anthropic/claude-sonnet-4-5
   EGRESS_ALLOWED_HOSTS=app.railway.internal
   ALLOW_LOCAL_DESTINATIONS=true
   ```

   No public domain unless something outside the project calls Kerby: the application reaches it at
   `http://kerby.railway.internal:8080` with `KERBY_API_KEY=${{kerby.KERBY_API_KEY}}`.
4. **`console`** (optional), from `ghcr.io/samchristensen/kerby-console:main` (or `RAILWAY_DOCKERFILE_PATH=services/console/Dockerfile`),
   with a public domain:

   ```
   KERBY_SECRET_KEY=${{kerby.KERBY_SECRET_KEY}}
   DATABASE_URL=${{kerby-postgres.DATABASE_URL}}
   API_URL=http://kerby.railway.internal:8080
   API_PUBLIC_URL=http://kerby.railway.internal:8080
   PUBLIC_URL=https://${{console.RAILWAY_PUBLIC_DOMAIN}}
   TRUST_PROXY=true
   PORT=3000
   ```

   and on `kerby`: `KERBY_ADMIN_EMAIL`, `KERBY_ADMIN_PASSWORD`, `CONSOLE_PUBLIC_URL=https://${{console.RAILWAY_PUBLIC_DOMAIN}}`.

More workers: a second service from the same image with `KERBY_ROLES=worker` and the same variables.

## Your own private services

The egress guard refuses private addresses for every URL the tenant supplies (ADR 0010), and on an install the tenant is
you: name your own services to let them through. `EGRESS_ALLOWED_HOSTS` (comma separated, exact host names) lets a tool
server (MCP) on that host be reached, and OAuth with it use plain http. `ALLOW_LOCAL_DESTINATIONS=true` lets webhook
subscriptions point at plain http and private addresses (`http://app.railway.internal:3000/hooks`). Everything else is
still checked.

## Postgres

- **Connection budget.** With one tenant, a `kerby` container holds at most about 50 connections: the api 13 (the
  tenant's pool of 2, one `LISTEN`, a control pool of 10), the worker 13 (pool, control pool, `LISTEN`), control 15 (pool,
  control pool, cluster admin pool, one while provisioning) and the dispatcher 8; the console 5; an extra worker container
  13. Postgres's default `max_connections` (100) is enough. The tenant's role may hold 20 at once
  (`TENANT_ROLE_CONNECTION_LIMIT`): a `kerby` container uses 9 of them, each extra worker container 2.
- **`NOTIFY` is sent outside writing transactions.** Postgres commits every transaction that sent a `NOTIFY` under one
  lock for the whole cluster, held through the commit's WAL flush, so a `NOTIFY` inside a write makes every write flush
  one at a time (measured: 9.2k against 20k inserts a second). A stored message is announced after its commit
  (`announcePersisted`), and live deltas are `NOTIFY`s alone.
- **Idle transactions.** A tenant database session left idle inside a transaction for 60 s is ended by the server
  (`idle_in_transaction_session_timeout`, set by `createTenantDb`), so a stalled process cannot hold a claim's advisory
  lock.
- **PgBouncer** is not used: transaction pooling breaks `LISTEN`, which event streams and the scheduler rely on.
- Control closes the maintenance databases (`postgres`, `template1`) and the tenant template to everyone but the
  superuser: this is why the Postgres is Kerby's alone.
- psql: `make psql` locally; on Railway, `railway connect kerby-postgres`.

## Backups

Two things hold an install's data and one opens it: the Postgres volume (the index, prompts, tools, events, sealed
secrets), the bucket (message bodies and traces) and `KERBY_SECRET_KEY`. Back up all three.

- Railway: the Postgres volume's backups (`railway postgres pitr schedule set --daily --service kerby-postgres`;
  restore with `railway postgres pitr backup restore <id>`); the bucket has no copy of its own, so copy it on a schedule
  (`rclone sync`, any S3 client) if a day's message bodies matter.
- Compose: the two volumes, `pg_dump` of every database (the tenant's is `t_<id>`), or the volumes' files while stopped.

## Alerts

`ALERT_WEBHOOK_URL` on `kerby` posts Kerby's own failures, since a platform cannot alert on log lines:
`alert(kind, fields)` (`@kerby/observability`) writes an error line with `alert: <kind>` and posts it:
`turn failed for good` and `lease lost` (worker), `provisioning failed`, `migration fan-out failed` and
`tenant retention failed` (control). A Slack URL (`hooks.slack.com`) gets `{"text"}`, Discord (`discord.com/api/webhooks`)
`{"content"}`, anything else the alert as JSON (`alert`, `service`, `environment`, `at`, `tenantId`, `fields`,
`suppressed`). One post per kind per process per five minutes; the next counts the ones held back. Posts carry tenant ids
and error names, never content or secrets; a failed post is logged (`alert post failed`) and never breaks the caller.
Unset, alerts are log lines only. Locally, `KERBY_ALERT_WEBHOOK_URL=http://host.docker.internal:<port>/ make up`. On
Railway, add the project's own notifications for crashed and failed deployments too: a crashed process restarts the
`kerby` container, and Railway reports it.

## Logs

Every line is JSON with `tenantId` and never message content; the launcher adds `service` (`control`, `api`, `worker`,
`dispatcher`). `make logs-query` filters the local stack's (`SERVICE=`, `TENANT=`, `LEVEL=warn`, `MSG=`, `SINCE=30m`);
on Railway, the service's log view filters the same fields (`@service:worker`, `@level:error`).

## Do not do

- Do not point `DATABASE_URL` at your application's Postgres: control changes who may connect to its databases.
- Do not lose `KERBY_SECRET_KEY`, or change it on an install with data: everything sealed with the old one stops opening.
- Do not run two containers with `control` in `KERBY_ROLES` against one install.
- Do not push a new image's first tag to GHCR by hand: the package is then created without a link to the repository,
  and CI's pushes to it are refused (`denied: permission_denied`). Let CI's `images` job create it.
