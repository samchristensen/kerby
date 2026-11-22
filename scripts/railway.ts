// Create, wire and deploy Kerby on Railway (ADR 0007). Run through `make railway-setup` and `make deploy`.
//   node scripts/railway.ts setup  [environment]   create what is missing and set every variable; safe to run again
//   node scripts/railway.ts deploy [environment]   upload this checkout: control first, then api and worker
// `environment` defaults to production. A name that does not exist yet is created as a copy of production and given
// secrets of its own. Needs the `railway` CLI, signed in, with the project linked (`railway init --name kerby`).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { generateSecretsKeyPair, publicKeyOf } from "@kerby/secrets";

const PRODUCTION = "production";
const BUCKET = "kerby";
const BUCKET_REGION = "iad";
const APP_ROLE = "kerby_app";
const SERVICES = ["control", "api", "worker"] as const;
type Service = (typeof SERVICES)[number];
/** The port each service listens on: Railway's health check and routing read `PORT`. */
const PORTS: Record<Service, number> = { control: 8081, api: 8080, worker: 8082 };

type Vars = Record<string, string>;

function railway(args: string[], input?: string): string {
  return execFileSync("railway", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  }).trim();
}

function railwayJson(args: string[], input?: string): unknown {
  return JSON.parse(railway([...args, "--json"], input));
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`unexpected railway output for ${what}: not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`unexpected railway output for ${what}: not a list`);
  return value.map((item) => record(item, what));
}

function text(value: Record<string, unknown>, key: string, what: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new Error(`unexpected railway output for ${what}: no "${key}"`);
  }
  return field;
}

const secret = () => randomBytes(24).toString("hex");
/** A reference Railway resolves at deploy time, to a variable of the Postgres service. */
const postgres = (name: string) => `\${{Postgres.${name}}}`;

function serviceIds(environment: string): Map<string, string> {
  const services = list(railwayJson(["service", "list", "--environment", environment]), "services");
  return new Map(services.map((s) => [text(s, "name", "service"), text(s, "id", "service")]));
}

function variablesOf(service: string, environment: string): Vars {
  const all = record(
    railwayJson(["variable", "list", "--service", service, "--environment", environment]),
    "variables",
  );
  return Object.fromEntries(
    Object.entries(all).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
}

/** Make `environment` exist (a copy of production when new) and be the CLI's linked environment, which `add` and `bucket create` act on. */
async function ensureEnvironment(environment: string): Promise<void> {
  const listed = record(railwayJson(["environment", "list"]), "environments");
  const known = list(listed.environments, "environments").map((e) =>
    text(e, "name", "environment"),
  );
  if (!known.includes(environment)) {
    if (!known.includes(PRODUCTION)) {
      throw new Error(`there is no "${PRODUCTION}" environment to copy "${environment}" from`);
    }
    railway(["environment", "new", environment, "--duplicate", PRODUCTION, "--json"]);
    // The copy's services appear a little later; creating them again would leave strays.
    for (let attempt = 0; ; attempt++) {
      const have = serviceIds(environment);
      if (["Postgres", ...SERVICES].every((name) => have.has(name))) break;
      if (attempt >= 30) throw new Error(`the services of "${environment}" did not appear`);
      await sleep(2000);
    }
  }
  railway(["environment", "link", environment]);
}

function ensureResources(environment: string): Map<string, string> {
  const have = serviceIds(environment);
  if (!have.has("Postgres")) railway(["add", "--database", "postgres", "--json"]);
  for (const name of SERVICES) {
    if (!have.has(name)) railway(["add", "--service", name, "--json"]);
  }
  const buckets = list(railwayJson(["bucket", "list", "--environment", environment]), "buckets");
  if (!buckets.some((b) => b.name === BUCKET)) {
    railway(["bucket", "create", BUCKET, "--region", BUCKET_REGION, "--json"]);
  }
  return serviceIds(environment);
}

/**
 * Secrets already on the control service are kept: the tenant secret in particular must never change on a live system.
 * A copy of production starts with production's secrets, which it must not share: those are replaced.
 * The secrets private key lives on the worker, the only service that opens tenants' model keys. Replacing it on a live
 * system would strand every key sealed to it, so it is kept like the tenant secret and is only made when there is none.
 */
function secretsFor(environment: string) {
  const existing = variablesOf("control", environment);
  const copied =
    environment !== PRODUCTION &&
    existing.TENANT_DB_SECRET !== undefined &&
    existing.TENANT_DB_SECRET === variablesOf("control", PRODUCTION).TENANT_DB_SECRET;
  const keep = copied ? {} : existing;
  const secretsPrivateKeys =
    (copied ? undefined : variablesOf("worker", environment).SECRETS_PRIVATE_KEYS) ??
    generateSecretsKeyPair().privateKey;
  return {
    secretsPrivateKeys,
    operatorToken: keep.OPERATOR_TOKEN ?? secret(),
    tenantDbSecret: keep.TENANT_DB_SECRET ?? secret(),
    appDatabasePassword: keep.APP_DATABASE_PASSWORD ?? secret(),
  };
}

async function setup(environment: string): Promise<void> {
  await ensureEnvironment(environment);
  const ids = ensureResources(environment);
  const id = (name: string): string => {
    const found = ids.get(name);
    if (!found) throw new Error(`service ${name} is missing after creating it`);
    return found;
  };

  const { operatorToken, tenantDbSecret, appDatabasePassword, secretsPrivateKeys } =
    secretsFor(environment);
  const bucket = record(
    railwayJson(["bucket", "credentials", "--bucket", BUCKET, "--environment", environment]),
    "bucket credentials",
  );
  // Every service reads the same keys (`@kerby/config`); the bucket's own values are copied in.
  const shared: Vars = {
    TENANT_DB_SECRET: tenantDbSecret,
    S3_ENDPOINT: text(bucket, "endpoint", "bucket credentials"),
    S3_REGION: text(bucket, "region", "bucket credentials"),
    S3_BUCKET: text(bucket, "bucketName", "bucket credentials"),
    S3_ACCESS_KEY_ID: text(bucket, "accessKeyId", "bucket credentials"),
    S3_SECRET_ACCESS_KEY: text(bucket, "secretAccessKey", "bucket credentials"),
  };
  const host = postgres("RAILWAY_PRIVATE_DOMAIN");
  const port = postgres("PGPORT");
  const limitedUrl = `postgresql://${APP_ROLE}:${appDatabasePassword}@${host}:${port}/${postgres("PGDATABASE")}`;

  const variables: Record<Service, Vars> = {
    // Only control holds the administrative credentials: it creates the limited role and every tenant database.
    control: {
      ...shared,
      CONTROL_DATABASE_URL: postgres("DATABASE_URL"),
      CLUSTER_ADMIN_URL: `postgresql://${postgres("PGUSER")}:${postgres("POSTGRES_PASSWORD")}@${host}:${port}/postgres`,
      CLUSTER_HOST: host,
      CLUSTER_PORT: port,
      OPERATOR_TOKEN: operatorToken,
      APP_DATABASE_PASSWORD: appDatabasePassword,
    },
    // The api seals tenants' model keys to the public half and cannot open them.
    api: {
      ...shared,
      CONTROL_DATABASE_URL: limitedUrl,
      SECRETS_PUBLIC_KEY: publicKeyOf(secretsPrivateKeys.split(",")[0] ?? ""),
    },
    worker: {
      ...shared,
      CONTROL_DATABASE_URL: limitedUrl,
      HEALTH_PORT: String(PORTS.worker),
      SECRETS_PRIVATE_KEYS: secretsPrivateKeys,
    },
  };

  const patch = {
    services: Object.fromEntries(
      SERVICES.map((name) => [
        id(name),
        {
          build: { builder: "DOCKERFILE", dockerfilePath: `services/${name}/Dockerfile` },
          deploy: { healthcheckPath: "/healthz", restartPolicyType: "ON_FAILURE" },
          variables: Object.fromEntries(
            Object.entries({ PORT: String(PORTS[name]), ...variables[name] }).map(
              ([key, value]) => [key, { value }],
            ),
          ),
        },
      ]),
    ),
  };
  railway(
    ["environment", "edit", "--environment", environment, "--json", "-m", "kerby: wire services"],
    JSON.stringify(patch),
  );

  const domains = record(
    railwayJson(["domain", "list", "--service", "api", "--environment", environment]),
    "domains",
  );
  if (list(domains.domains, "domains").length === 0) {
    railway(["domain", "--service", "api", "--environment", environment, "--json"]);
  }
  console.log(`railway "${environment}" is configured. Next: make deploy ENV=${environment}`);
}

/** Statuses a deployment does not leave. */
const FINAL: Record<string, true> = {
  SUCCESS: true,
  FAILED: true,
  CRASHED: true,
  REMOVED: true,
  SKIPPED: true,
};

async function rollout(service: Service, environment: string, message: string): Promise<void> {
  const startedAt = Date.now() - 60_000; // the clocks differ a little
  railway(["up", "--service", service, "--environment", environment, "--detach", "-m", message]);
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const latest = list(
      railwayJson([
        "deployment",
        "list",
        "--service",
        service,
        "--environment",
        environment,
        "--limit",
        "1",
      ]),
      "deployments",
    )[0];
    if (latest && Date.parse(text(latest, "createdAt", "deployment")) >= startedAt) {
      const status = text(latest, "status", "deployment");
      if (FINAL[status]) {
        if (status !== "SUCCESS") {
          throw new Error(
            `${service} deployment ${status}: railway logs --service ${service} -e ${environment}`,
          );
        }
        console.log(`${service}: deployed`);
        return;
      }
    }
    if (Date.now() > deadline) throw new Error(`${service}: no result after 20 minutes`);
    await sleep(5000);
  }
}

async function deploy(environment: string): Promise<void> {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const dirty = git("status", "--porcelain") === "" ? "" : "+dirty";
  const message = `${git("rev-parse", "--short=12", "HEAD")}${dirty}`;
  // control first: it creates the limited database role that api and worker connect as.
  await rollout("control", environment, message);
  await Promise.all([
    rollout("api", environment, message),
    rollout("worker", environment, message),
  ]);
}

const [command, environment = PRODUCTION] = process.argv.slice(2);
if (command === "setup") await setup(environment);
else if (command === "deploy") await deploy(environment);
else {
  console.error("usage: node scripts/railway.ts <setup|deploy> [environment]");
  process.exit(1);
}
