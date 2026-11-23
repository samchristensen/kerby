// The control service: the operator API. This file is the composition root: it builds the real adapters.
import { createBucket } from "@kerby/blobs";
import {
  controlMigrationsDir,
  resolveTenantDbUrl,
  restrictControlDatabase,
  setRolePassword,
} from "@kerby/control-plane";
import { createClusterAdmin, createControlDb, migrate, TenantPools } from "@kerby/db";
import { configureAlerts, errorFields, flushAlerts, log } from "@kerby/observability";
import { createSecretBox, splitKeys } from "@kerby/secrets";
import { serve } from "@kerby/serve";
import { type ControlConfig, loadControlConfig } from "./config/index.ts";
import { createControlApp } from "./runtime/http.ts";
import { startNightly } from "./runtime/nightly.ts";
import { ensureTenantDbPasswords } from "./service/db-credentials.ts";
import { migrateAllTenants } from "./service/migrate.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import type { ControlDeps } from "./types/index.ts";

export { createControlApp } from "./runtime/http.ts";

/** Build the adapters for `config` and prepare the databases: everything the server and the release command share. */
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
  const buckets = {
    primary: createBucket({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      bucket: config.s3Bucket,
      credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
    }),
    exports: createBucket({
      endpoint: config.exportS3Endpoint,
      region: config.exportS3Region,
      bucket: config.exportS3Bucket,
      credentials: {
        accessKeyId: config.exportS3AccessKeyId,
        secretAccessKey: config.exportS3SecretAccessKey,
      },
    }),
    backup: createBucket({
      endpoint: config.backupS3Endpoint,
      region: config.backupS3Region,
      bucket: config.backupS3Bucket,
      credentials: {
        accessKeyId: config.backupS3AccessKeyId,
        secretAccessKey: config.backupS3SecretAccessKey,
      },
    }),
  };
  for (const bucket of Object.values(buckets)) await bucket.ensureBucket();
  const pools = new TenantPools({
    resolveUrl: (tenantId) =>
      resolveTenantDbUrl(control, tenantDbBox, tenantId, config.tenantDbSslmode),
  });
  const deps: ControlDeps = {
    control,
    cluster,
    buckets,
    now: () => new Date(),
    pools,
    tenantDbBox,
    settings: {
      clusterHost: config.clusterHost,
      clusterPort: config.clusterPort,
      tenantDbSslmode: config.tenantDbSslmode,
      templateDatabase: config.templateDatabase,
      pgDumpPath: config.pgDumpPath,
    },
  };
  await ensureTemplate(deps);
  await restrictClusterDatabases(deps);
  await ensureTenantDbPasswords(deps);
  return {
    deps,
    async close() {
      await pools.close();
      await cluster.close();
      await control.close();
      await flushAlerts();
    },
  };
}

/** Prepare, then listen. */
async function startControl(config: ControlConfig) {
  const prepared = await prepareControl(config);
  const { deps } = prepared;
  const server = await serve(
    createControlApp(deps, { operator: config.operatorToken, console: config.consoleToken }),
    { host: config.host, port: config.port },
  );
  const nightly = startNightly(deps);
  log("info", "control listening", { port: server.port });
  return {
    port: server.port,
    deps,
    async close() {
      await server.close();
      await nightly.stop();
      await prepared.close();
    },
  };
}

/**
 * The release command (`node services/control/src/index.ts migrate`, Railway's pre-deploy command for control): migrate
 * the control database and every tenant database with this release's code, before the release's control starts. A
 * tenant that fails fails the command, so Railway keeps the previous release running and the rest of the release stops.
 */
async function migrateRelease(config: ControlConfig): Promise<void> {
  const prepared = await prepareControl(config);
  try {
    const run = await migrateAllTenants(prepared.deps);
    log("info", "tenant migrations done", { migrated: run.migrated, failed: run.failed.length });
    if (run.failed.length > 0) {
      throw new Error(
        `tenant migrations failed for ${run.failed.length} tenant(s): ${JSON.stringify(run.failed)}`,
      );
    }
  } finally {
    await prepared.close();
  }
}

if (import.meta.main) {
  if (process.argv[2] === "migrate") {
    try {
      await migrateRelease(loadControlConfig());
    } catch (error) {
      log("error", "release migration failed", errorFields(error));
      process.exit(1);
    }
    process.exit(0);
  }
  const running = await startControl(loadControlConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
