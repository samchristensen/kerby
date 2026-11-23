// Kerby's Railway infrastructure (ADRs 0007, 0011). `make railway-plan` previews, `make railway-setup` applies; the runbook
// is docs/deploy.md. The same file describes every environment: a new one starts empty and this makes it whole.
//
// What is NOT here, on purpose:
//  - Secrets. A generated value (`${{secret(n)}}`) is made again on every apply, which would rotate SECRETS_PRIVATE_KEYS
//    and strand every stored model key. They are `preserve()`: `scripts/railway.ts secrets` creates each once and never
//    replaces it. ALERT_WEBHOOK_URL is `preserve()` too: an operator sets it per environment with `railway variable set`
//    (docs/deploy.md#alerts), and unset it is simply absent.
//  - The api's and the console's generated domains (the IaC does not manage generated domains): `scripts/railway.ts
//    domains` adds them.
//  - Code. Railway builds nothing: CI builds each service's image and pushes it to GHCR as `sha-<commit>`, then
//    `scripts/railway.ts deploy` points the environment's tag (`kerby-<service>:<environment>`) at it and redeploys.
//  - Registry credentials for GHCR: a token cannot live in this file; `scripts/railway.ts registry` sets them.
//  - The database volume's backup schedule: `railway postgres pitr schedule set --daily --service Postgres` (daily,
//    kept 6 days). Declaring it here would make the IaC re-attach the live volume; Railway's export does not show it.
import {
  bucket,
  defineRailway,
  image,
  postgres,
  preserve,
  project,
  ref,
  service,
  volume,
} from "railway/iac";

const REGION = "us-east4-eqdc4a";
const BUCKET_REGION = "iad";
const REGISTRY = "ghcr.io/samchristensen";
/** The backup copy lives in another region than the bucket it copies (ADR 0013). */
const BACKUP_REGION = "sjc";

export default defineRailway((ctx) => {
  const environment = ctx.environmentName ?? ctx.environment;
  if (!environment) throw new Error("railway gave no environment name to .railway/railway.ts");
  // Each environment runs the image its own tag points at; `scripts/railway.ts deploy` moves the tag.
  const source = (name: string) => image(`${REGISTRY}/kerby-${name}:${environment}`);
  const db = postgres("Postgres", { region: REGION });
  db.networking = { privateNetworkEndpoint: "postgres" };
  const dbVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 50_000,
  });
  const storage = bucket("kerby", { region: BUCKET_REGION });
  // Only control references these two: tenant exports, and the nightly copy of `kerby`'s `t/` (ADR 0013).
  const exportsBucket = bucket("kerby-exports", { region: BUCKET_REGION });
  const backupBucket = bucket("kerby-backup", { region: BACKUP_REGION });

  // References Railway resolves at deploy time. Strings, because they join into URLs.
  const variable = (resource: string, name: string) => `\${{${resource}.${name}}}`;
  const host = variable("Postgres", "RAILWAY_PRIVATE_DOMAIN");
  const port = variable("Postgres", "PGPORT");
  const adminUrl = `postgresql://${variable("Postgres", "PGUSER")}:${variable("Postgres", "POSTGRES_PASSWORD")}@${host}:${port}/postgres`;
  // The limited roles: api and worker connect as `kerby_app`, the console as `kerby_console`. Control creates both and
  // sets their passwords at startup.
  const database = variable("Postgres", "PGDATABASE");
  const limitedUrl = `postgresql://kerby_app:${variable("control", "APP_DATABASE_PASSWORD")}@${host}:${port}/${database}`;
  const consoleUrl = `postgresql://kerby_console:${variable("control", "CONSOLE_DATABASE_PASSWORD")}@${host}:${port}/${database}`;

  // A bucket's five variables, under `<prefix>S3_*`.
  const s3Of = (resource: typeof storage, prefix: string) => ({
    [`${prefix}S3_ENDPOINT`]: ref(resource, "ENDPOINT"),
    [`${prefix}S3_REGION`]: ref(resource, "REGION"),
    [`${prefix}S3_BUCKET`]: ref(resource, "BUCKET"),
    [`${prefix}S3_ACCESS_KEY_ID`]: ref(resource, "ACCESS_KEY_ID"),
    [`${prefix}S3_SECRET_ACCESS_KEY`]: ref(resource, "SECRET_ACCESS_KEY"),
  });
  const s3 = s3Of(storage, "");

  // Where every service posts its alerts (Slack, Discord or JSON); the operator's channel, never generated.
  const alerts = { ALERT_WEBHOOK_URL: preserve() };

  // Control holds the administrative credentials: it makes the limited roles and every tenant database. Its secrets are
  // the source; api and worker reference TENANT_DB_KEYS (which opens tenant database passwords, ADR 0009) and the console
  // CONSOLE_TOKEN, so there is one copy of each.
  const control = service("control", {
    source: source("control"),
    healthcheck: "/healthz",
    env: {
      // Every address: the console reaches control over the private network, which may be IPv6.
      HOST: "::",
      PORT: "8081",
      ...s3,
      ...s3Of(exportsBucket, "EXPORT_"),
      ...s3Of(backupBucket, "BACKUP_"),
      CONTROL_DATABASE_URL: db.env.DATABASE_URL,
      CLUSTER_ADMIN_URL: adminUrl,
      CLUSTER_HOST: host,
      CLUSTER_PORT: port,
      OPERATOR_TOKEN: preserve(),
      TENANT_DB_KEYS: preserve(),
      APP_DATABASE_PASSWORD: preserve(),
      // Opens self-serve sign-up (`POST /v1/console/signups`) and nothing else (ADR 0014).
      CONSOLE_TOKEN: preserve(),
      CONSOLE_DATABASE_PASSWORD: preserve(),
      ...alerts,
    },
  });

  // The api seals tenants' model keys to the public half of the secrets key pair and cannot open them (ADR 0008).
  const api = service("api", {
    source: source("api"),
    healthcheck: "/healthz",
    env: {
      // Every address: the console reaches the api over the private network, which may be IPv6.
      HOST: "::",
      PORT: "8080",
      ...s3,
      CONTROL_DATABASE_URL: limitedUrl,
      TENANT_DB_KEYS: control.env.TENANT_DB_KEYS,
      SECRETS_PUBLIC_KEY: preserve(),
      ...alerts,
      // Tool servers connected with OAuth (ADR 0019): Kerby's redirect URI and client id live on the console's domain.
      CONSOLE_PUBLIC_URL: `https://${variable("console", "RAILWAY_PUBLIC_DOMAIN")}`,
      // Railway's edge writes X-Forwarded-For with the client first: the failed-auth limit counts that address.
      TRUST_PROXY: "true",
    },
  });

  // The worker alone holds the private half: it opens a tenant's key inside the run that uses it.
  const worker = service("worker", {
    source: source("worker"),
    healthcheck: "/healthz",
    env: {
      PORT: "8082",
      HEALTH_PORT: "8082",
      ...s3,
      CONTROL_DATABASE_URL: limitedUrl,
      TENANT_DB_KEYS: control.env.TENANT_DB_KEYS,
      SECRETS_PRIVATE_KEYS: preserve(),
      ...alerts,
    },
  });

  // The console (ADR 0014): sign-up, sign-in, integrations and keys, model keys, tools and chat. Public, like the api. It
  // seals model keys to the api's public key, reaches control only on its sign-up route and the api with the signed-in
  // person's session.
  const consoleService = service("console", {
    source: source("console"),
    healthcheck: "/healthz",
    env: {
      PORT: "3000",
      CONTROL_DATABASE_URL: consoleUrl,
      CONTROL_URL: `http://${variable("control", "RAILWAY_PRIVATE_DOMAIN")}:8081`,
      // The browser's chat reaches the tenant API over the private network, with the person's session token.
      API_URL: `http://${variable("api", "RAILWAY_PRIVATE_DOMAIN")}:8080`,
      CONSOLE_TOKEN: control.env.CONSOLE_TOKEN,
      SECRETS_PUBLIC_KEY: api.env.SECRETS_PUBLIC_KEY,
      API_PUBLIC_URL: `https://${variable("api", "RAILWAY_PUBLIC_DOMAIN")}`,
      // Its own address, the api's CONSOLE_PUBLIC_URL: Kerby's OAuth client metadata document is served under it.
      PUBLIC_URL: `https://${variable("console", "RAILWAY_PUBLIC_DOMAIN")}`,
      // Railway's edge writes X-Forwarded-For with the client first: the sign-up and sign-in limits count that address.
      TRUST_PROXY: "true",
    },
  });

  return project("kerby", {
    resources: [
      control,
      api,
      worker,
      consoleService,
      db,
      dbVolume,
      storage,
      exportsBucket,
      backupBucket,
    ],
  });
});
