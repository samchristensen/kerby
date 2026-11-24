// What each process of an install is started with (ADR 0024): its entry file, the variables the launcher derives for
// it, and where it answers its health. Everything else in the container's environment passes through unchanged, so a
// setting such as S3_BUCKET or DEFAULT_MODEL reaches every process that reads it.
import { join } from "node:path";
import { postgresUrl } from "@kerby/db";
import type { InstanceKeys } from "@kerby/secrets";
import type { LauncherConfig, Role } from "../config/index.ts";

export type ProcessSpec = {
  role: Role;
  /** The service's entry file. */
  entry: string;
  /** Set on top of the container's environment; these win over anything set there. */
  env: Record<string, string>;
  /** Answers 200 once the process is ready. */
  healthUrl: string;
};

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
/** Control answers only inside the container; the api is the one published port. */
const CONTROL_PORT = 8081;
const WORKER_HEALTH_PORT = 8082;
const DISPATCHER_HEALTH_PORT = 8083;

/** The processes `config.kerbyRoles` names, control first: the others start once it is healthy. */
export function processSpecs(config: LauncherConfig, keys: InstanceKeys): ProcessSpec[] {
  const admin = new URL(config.databaseUrl);
  const asApp = postgresUrl(config.databaseUrl, {
    role: "kerby_app",
    password: keys.appDatabasePassword,
  });
  const specs: Record<Role, Omit<ProcessSpec, "role" | "entry">> = {
    control: {
      env: {
        CONTROL_DATABASE_URL: config.databaseUrl,
        CLUSTER_ADMIN_URL: postgresUrl(config.databaseUrl, { database: "postgres" }),
        CLUSTER_HOST: admin.hostname,
        CLUSTER_PORT: admin.port || "5432",
        TENANT_DB_KEYS: keys.tenantDbKey,
        APP_DATABASE_PASSWORD: keys.appDatabasePassword,
        CONSOLE_DATABASE_PASSWORD: keys.consoleDatabasePassword,
        HOST: "127.0.0.1",
        PORT: String(CONTROL_PORT),
      },
      healthUrl: `http://127.0.0.1:${CONTROL_PORT}/healthz`,
    },
    api: {
      env: {
        CONTROL_DATABASE_URL: asApp,
        TENANT_DB_KEYS: keys.tenantDbKey,
        SECRETS_PUBLIC_KEY: keys.secrets.publicKey,
        DELIVERY_SECRETS_PUBLIC_KEY: keys.delivery.publicKey,
        HOST: config.host,
        PORT: String(config.port),
      },
      healthUrl: `http://127.0.0.1:${config.port}/healthz`,
    },
    worker: {
      env: {
        CONTROL_DATABASE_URL: asApp,
        TENANT_DB_KEYS: keys.tenantDbKey,
        SECRETS_PRIVATE_KEYS: keys.secrets.privateKey,
        HEALTH_PORT: String(WORKER_HEALTH_PORT),
      },
      healthUrl: `http://127.0.0.1:${WORKER_HEALTH_PORT}/healthz`,
    },
    dispatcher: {
      env: {
        CONTROL_DATABASE_URL: asApp,
        TENANT_DB_KEYS: keys.tenantDbKey,
        DELIVERY_SECRETS_PRIVATE_KEYS: keys.delivery.privateKey,
        HEALTH_PORT: String(DISPATCHER_HEALTH_PORT),
      },
      healthUrl: `http://127.0.0.1:${DISPATCHER_HEALTH_PORT}/healthz`,
    },
  };
  const ordered = [...config.kerbyRoles].sort(
    (a, b) => Number(b === "control") - Number(a === "control"),
  );
  return ordered.map((role) => ({
    role,
    entry: join(ROOT, "services", role, "src", "index.ts"),
    ...specs[role],
  }));
}
