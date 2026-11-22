// Kerby's Railway infrastructure (ADR 0007). `make railway-plan` previews, `make railway-setup` applies; the runbook is
// docs/deploy.md. The same file describes every environment: a new one starts empty and this makes it whole.
//
// What is NOT here, on purpose:
//  - Secrets. A generated value (`${{secret(n)}}`) is made again on every apply, which would rotate TENANT_DB_SECRET and
//    strand every tenant database. They are `preserve()`: `scripts/railway.ts secrets` creates each once and never
//    replaces it.
//  - The api's generated domain (the IaC does not manage generated domains): `scripts/railway.ts setup` adds it.
//  - Code. Services have no `source`: `make deploy` uploads this checkout with `railway up`.
import {
  bucket,
  defineRailway,
  postgres,
  preserve,
  project,
  ref,
  service,
  volume,
} from "railway/iac";

const REGION = "us-east4-eqdc4a";
const BUCKET_REGION = "iad";

export default defineRailway(() => {
  const db = postgres("Postgres", { region: REGION });
  db.networking = { privateNetworkEndpoint: "postgres" };
  const dbVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: REGION,
    sizeMB: 50_000,
  });
  const storage = bucket("kerby", { region: BUCKET_REGION });

  // References Railway resolves at deploy time. Strings, because they join into URLs.
  const variable = (resource: string, name: string) => `\${{${resource}.${name}}}`;
  const host = variable("Postgres", "RAILWAY_PRIVATE_DOMAIN");
  const port = variable("Postgres", "PGPORT");
  const adminUrl = `postgresql://${variable("Postgres", "PGUSER")}:${variable("Postgres", "POSTGRES_PASSWORD")}@${host}:${port}/postgres`;
  // The limited role api and worker connect as; control creates it and sets its password at startup.
  const limitedUrl = `postgresql://kerby_app:${variable("control", "APP_DATABASE_PASSWORD")}@${host}:${port}/${variable("Postgres", "PGDATABASE")}`;

  const s3 = {
    S3_ENDPOINT: ref(storage, "ENDPOINT"),
    S3_REGION: ref(storage, "REGION"),
    S3_BUCKET: ref(storage, "BUCKET"),
    S3_ACCESS_KEY_ID: ref(storage, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(storage, "SECRET_ACCESS_KEY"),
  };

  // Control holds the administrative credentials: it makes the limited role and every tenant database. Its secrets are the
  // source; api and worker reference TENANT_DB_SECRET so there is one copy.
  const control = service("control", {
    build: { builder: "DOCKERFILE", dockerfilePath: "services/control/Dockerfile" },
    healthcheck: "/healthz",
    env: {
      PORT: "8081",
      ...s3,
      CONTROL_DATABASE_URL: db.env.DATABASE_URL,
      CLUSTER_ADMIN_URL: adminUrl,
      CLUSTER_HOST: host,
      CLUSTER_PORT: port,
      OPERATOR_TOKEN: preserve(),
      TENANT_DB_SECRET: preserve(),
      APP_DATABASE_PASSWORD: preserve(),
    },
  });

  // The api seals tenants' model keys to the public half of the secrets key pair and cannot open them (ADR 0008).
  const api = service("api", {
    build: { builder: "DOCKERFILE", dockerfilePath: "services/api/Dockerfile" },
    healthcheck: "/healthz",
    env: {
      PORT: "8080",
      ...s3,
      CONTROL_DATABASE_URL: limitedUrl,
      TENANT_DB_SECRET: control.env.TENANT_DB_SECRET,
      SECRETS_PUBLIC_KEY: preserve(),
    },
  });

  // The worker alone holds the private half: it opens a tenant's key inside the run that uses it.
  const worker = service("worker", {
    build: { builder: "DOCKERFILE", dockerfilePath: "services/worker/Dockerfile" },
    healthcheck: "/healthz",
    env: {
      PORT: "8082",
      HEALTH_PORT: "8082",
      ...s3,
      CONTROL_DATABASE_URL: limitedUrl,
      TENANT_DB_SECRET: control.env.TENANT_DB_SECRET,
      SECRETS_PRIVATE_KEYS: preserve(),
    },
  });

  return project("kerby", { resources: [control, api, worker, db, dbVolume, storage] });
});
