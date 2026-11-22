// Operate Kerby on Railway (ADRs 0007, 0011). Run through `make railway-plan`, `make railway-setup` and `make deploy`.
//   node scripts/railway.ts plan     [environment]        preview what `.railway/railway.ts` would change
//   node scripts/railway.ts setup    [environment]        make the environment match `.railway/railway.ts`, add its domain and secrets
//   node scripts/railway.ts secrets  [environment]        create the secrets the IaC file leaves to preserve(); never replaces one
//   node scripts/railway.ts registry [environment]        give each service the GHCR pull token in $GHCR_PULL_TOKEN
//   node scripts/railway.ts deploy   [environment] [tag]  point the environment's image tag at `tag` (default: this commit's
//                                                         `sha-<commit>`, built by CI) and redeploy: control first, then api and worker
// The infrastructure is Railway Infrastructure as Code in `.railway/railway.ts`; this script does only what that file cannot:
// make an environment, generate secrets once, add the generated domain, set registry credentials, and roll images out.
// Railway builds nothing: CI builds and pushes the images (.github/workflows/ci.yml). `environment` defaults to production;
// a new name is a copy of it with secrets of its own.
// Needs the `railway` CLI (signed in, or RAILWAY_TOKEN for one environment) with the project linked, and for `deploy`, docker
// logged in to ghcr.io with permission to push tags.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { generateSecretsKeyPair, publicKeyOf } from "@kerby/secrets";

const PRODUCTION = "production";
const SERVICES = ["control", "api", "worker"] as const;
type Service = (typeof SERVICES)[number];
const REGISTRY_OWNER = "samchristensen";
const imageOf = (service: Service, tag: string) =>
  `ghcr.io/${REGISTRY_OWNER}/kerby-${service}:${tag}`;

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

function serviceNames(environment: string): Set<string> {
  const services = list(railwayJson(["service", "list", "--environment", environment]), "services");
  return new Set(services.map((s) => text(s, "name", "service")));
}

/**
 * Make `environment` exist and be the CLI's linked environment. A new one is a copy of production: Railway gives a copy its
 * own Postgres and bucket instances, which an empty environment filled in by the IaC file does not get (the bucket is
 * never deployed). The IaC file then reconciles the copy, and `ensureSecrets` replaces the secrets it inherited.
 */
function ensureEnvironment(environment: string): void {
  const listed = record(railwayJson(["environment", "list"]), "environments");
  const known = list(listed.environments, "environments").map((e) =>
    text(e, "name", "environment"),
  );
  if (!known.includes(environment)) {
    if (!known.includes(PRODUCTION)) {
      throw new Error(`there is no "${PRODUCTION}" environment to copy "${environment}" from`);
    }
    railway(["environment", "new", environment, "--duplicate", PRODUCTION, "--json"]);
    // The copy's services appear a little later; applying before they do would create strays.
    for (let attempt = 0; ; attempt++) {
      const have = serviceNames(environment);
      if (["Postgres", ...SERVICES].every((name) => have.has(name))) break;
      if (attempt >= 30) throw new Error(`the services of "${environment}" did not appear`);
      execFileSync("sleep", ["2"]);
    }
  }
  railway(["environment", "link", environment]);
}

/** `railway config <plan|apply>` on the linked environment, shown as it runs. Deletions need a human: no --confirm-destructive. */
function iac(command: "plan" | "apply", ...flags: string[]): void {
  // The SDK reads `$_` (the shell's last command) as the CLI to ask for its version; under node that is node. Name the CLI.
  execFileSync("railway", ["config", command, ...flags], {
    stdio: "inherit",
    env: { ...process.env, _: "railway" },
  });
}

/**
 * Create each secret the IaC file leaves to `preserve()`, once. A secret that exists is never replaced: TENANT_DB_SECRET
 * derives every tenant role's password and SECRETS_PRIVATE_KEYS opens every stored tenant key. Variables are set without
 * a deploy: `deploy` is what rolls them out.
 */
function ensureSecrets(environment: string): void {
  const set = (service: Service, name: string, value: string) =>
    railway(
      [
        "variable",
        "set",
        name,
        "--stdin",
        "--service",
        service,
        "--environment",
        environment,
        "--skip-deploys",
      ],
      value,
    );
  const control = variablesOf("control", environment);
  // A copy of production starts with production's secrets, which it must not share: those are replaced.
  const copied =
    environment !== PRODUCTION &&
    control.TENANT_DB_SECRET !== undefined &&
    control.TENANT_DB_SECRET === variablesOf("control", PRODUCTION).TENANT_DB_SECRET;
  for (const name of ["OPERATOR_TOKEN", "TENANT_DB_SECRET", "APP_DATABASE_PASSWORD"]) {
    if (control[name] === undefined || copied) set("control", name, secret());
  }
  const existing = copied ? undefined : variablesOf("worker", environment).SECRETS_PRIVATE_KEYS;
  const privateKeys = existing ?? generateSecretsKeyPair().privateKey;
  if (existing === undefined) set("worker", "SECRETS_PRIVATE_KEYS", privateKeys);
  // The public half is not a secret and always follows the key new secrets are sealed to (the first of the list).
  const publicKey = publicKeyOf(privateKeys.split(",")[0] ?? "");
  if (variablesOf("api", environment).SECRETS_PUBLIC_KEY !== publicKey) {
    set("api", "SECRETS_PUBLIC_KEY", publicKey);
  }
}

/** The api's Railway-generated domain; the IaC file does not manage generated domains. */
function ensureDomain(environment: string): void {
  const domains = record(
    railwayJson(["domain", "list", "--service", "api", "--environment", environment]),
    "domains",
  );
  if (list(domains.domains, "domains").length === 0) {
    railway(["domain", "--service", "api", "--environment", environment, "--json"]);
  }
}

function setup(environment: string): void {
  ensureEnvironment(environment);
  iac("apply", "--yes");
  ensureDomain(environment);
  ensureSecrets(environment);
  console.log(
    `railway "${environment}" matches .railway/railway.ts. Next: make deploy ENV=${environment}`,
  );
}

/** Statuses a deployment does not leave. */
const FINAL: Record<string, true> = {
  SUCCESS: true,
  FAILED: true,
  CRASHED: true,
  REMOVED: true,
  SKIPPED: true,
};

/**
 * Point `kerby-<service>:<environment>` at `tag` and redeploy the service from its source, which pulls the tag afresh
 * (`--from-source`; a plain redeploy would reuse the previous image). Waits for the deployment to settle.
 */
async function rollout(service: Service, environment: string, tag: string): Promise<void> {
  execFileSync(
    "docker",
    [
      "buildx",
      "imagetools",
      "create",
      "--tag",
      imageOf(service, environment),
      imageOf(service, tag),
    ],
    { stdio: "inherit" },
  );
  const startedAt = Date.now() - 60_000; // the clocks differ a little
  railway([
    "redeploy",
    "--service",
    service,
    "--environment",
    environment,
    "--from-source",
    "--yes",
  ]);
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
        console.log(`${service}: ${tag} deployed`);
        return;
      }
    }
    if (Date.now() > deadline) throw new Error(`${service}: no result after 20 minutes`);
    await sleep(5000);
  }
}

async function deploy(environment: string, tag: string): Promise<void> {
  // Every image must exist before any service moves, so a release never stops half-way for a missing image.
  for (const service of SERVICES) {
    execFileSync("docker", ["buildx", "imagetools", "inspect", imageOf(service, tag)], {
      stdio: "ignore",
    });
  }
  // control first: it migrates the control database and creates the limited role api and worker connect as.
  await rollout("control", environment, tag);
  await Promise.all([rollout("api", environment, tag), rollout("worker", environment, tag)]);
}

/**
 * GHCR images are private: give each service the pull token (a classic token with `read:packages` only). Set through the
 * API because a token cannot live in the IaC file; safe to repeat.
 */
function registry(environment: string): void {
  const token = process.env.GHCR_PULL_TOKEN;
  if (!token)
    throw new Error("GHCR_PULL_TOKEN is not set: a classic GitHub token with read:packages only");
  const environments = list(
    record(railwayJson(["environment", "list"]), "environments").environments,
    "environments",
  );
  const environmentId = text(
    environments.find((e) => e.name === environment) ?? {},
    "id",
    `environment ${environment}`,
  );
  const services = list(railwayJson(["service", "list", "--environment", environment]), "services");
  for (const service of SERVICES) {
    const serviceId = text(
      services.find((s) => s.name === service) ?? {},
      "id",
      `service ${service}`,
    );
    railway(
      [
        "api",
        "mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }",
        "--variables",
        "@-",
      ],
      JSON.stringify({
        serviceId,
        environmentId,
        input: { registryCredentials: { username: REGISTRY_OWNER, password: token } },
      }),
    );
    console.log(`${service}: registry credentials set`);
  }
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const [command, environment = PRODUCTION, tag] = process.argv.slice(2);
if (command === "plan") {
  ensureEnvironment(environment);
  iac("plan");
} else if (command === "setup") setup(environment);
else if (command === "secrets") ensureSecrets(environment);
else if (command === "registry") registry(environment);
else if (command === "deploy") await deploy(environment, tag ?? `sha-${git("rev-parse", "HEAD")}`);
else {
  console.error(
    "usage: node scripts/railway.ts <plan|setup|secrets|registry|deploy> [environment] [tag]",
  );
  process.exit(1);
}
