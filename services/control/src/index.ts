// The control service: prepares Kerby's Postgres and the install's one tenant, then runs nightly retention (ADR 0024).
// This file is the composition root: it builds the real adapters.
import { createBucket } from "@kerby/blobs";
import {
  controlMigrationsDir,
  PASSWORD_COST,
  resolveTenantDbUrl,
  restrictControlDatabase,
  setRolePassword,
} from "@kerby/control-plane";
import { createClusterAdmin, createControlDb, migrate, TenantPools } from "@kerby/db";
import { configureAlerts, errorFields, flushAlerts, log } from "@kerby/observability";
import { createSecretBox, splitKeys } from "@kerby/secrets";
import { createRouter, json, serve } from "@kerby/serve";
import { type ControlConfig, loadControlConfig } from "./config/index.ts";
import { startNightly } from "./runtime/nightly.ts";
import { ensureTenantDbPasswords } from "./service/db-credentials.ts";
import { bootstrapInstance } from "./service/instance.ts";
import { migrateAllTenants } from "./service/migrate.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import type { ControlDeps } from "./types/index.ts";

/**
 * Prepare the databases and the install: the control migrations and roles, the template, every tenant database
 * migrated, the tenant, its key and its admin. Throws on anything that leaves the install unusable.
 */
async function prepareControl(config: ControlConfig) {
  configureAlerts({
    service: "control",
    environment: config.railwayEnvironmentName,
    webhookUrl: config.alertWebhookUrl,
  });
  const tenantDbBox = createSecretBox(splitKeys(config.tenantDbKeys), "TENANT_DB_KEYS key");
  const control = createControlDb(config.controlDatabaseUrl);
  await migrate(control, [controlMigrationsDir]);
  if (config.appDatabasePassword) {
    await setRolePassword(control, "kerby_app", config.appDatabasePassword);
  }
  if (config.consoleDatabasePassword) {
    await setRolePassword(control, "kerby_console", config.consoleDatabasePassword);
  }
  await restrictControlDatabase(control);

  const cluster = createClusterAdmin(config.clusterAdminUrl);
  const bucket = createBucket({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  });
  await bucket.ensureBucket();
  const pools = new TenantPools({
    resolveUrl: (tenantId) =>
      resolveTenantDbUrl(control, tenantDbBox, tenantId, config.tenantDbSslmode),
  });
  const deps: ControlDeps = {
    control,
    cluster,
    bucket,
    pools,
    tenantDbBox,
    settings: {
      clusterHost: config.clusterHost,
      clusterPort: config.clusterPort,
      tenantDbSslmode: config.tenantDbSslmode,
      templateDatabase: config.templateDatabase,
    },
  };
  const close = async () => {
    await pools.close();
    await cluster.close();
    await control.close();
    await flushAlerts();
  };
  try {
    await ensureTemplate(deps);
    await restrictClusterDatabases(deps);
    await ensureTenantDbPasswords(deps);
    const run = await migrateAllTenants(deps);
    if (run.failed.length > 0) {
      throw new Error(`tenant migrations failed: ${JSON.stringify(run.failed)}`);
    }
    await bootstrapInstance(deps, {
      tenantName: config.kerbyTenantName,
      apiKey: config.kerbyApiKey,
      admin:
        config.kerbyAdminEmail !== undefined && config.kerbyAdminPassword !== undefined
          ? { email: config.kerbyAdminEmail, password: config.kerbyAdminPassword }
          : undefined,
      passwordCost: PASSWORD_COST,
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { deps, close };
}

/** Prepare, then answer health and keep the nightly timer. */
async function startControl(config: ControlConfig) {
  const prepared = await prepareControl(config);
  const server = await serve(createRouter([["GET", "/healthz", () => json(200, { ok: true })]]), {
    host: config.host,
    port: config.port,
  });
  const nightly = startNightly(prepared.deps);
  log("info", "control ready", { port: server.port });
  return {
    async close() {
      await server.close();
      await nightly.stop();
      await prepared.close();
    },
  };
}

if (import.meta.main) {
  const config = loadControlConfig();
  const running = await startControl(config).catch((error: unknown) => {
    log("error", "control could not prepare the install", errorFields(error));
    process.exit(1);
  });
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
