// The control service: the operator API. This file is the composition root: it builds the real adapters.
import { createBucket } from "@kerby/blobs";
import {
  controlMigrationsDir,
  getTenant,
  restrictControlDatabase,
  setAppRolePassword,
  tenantDbUrl,
} from "@kerby/control-plane";
import { createClusterAdmin, createControlDb, migrate, TenantPools } from "@kerby/db";
import { configureAlerts, flushAlerts, log } from "@kerby/observability";
import { serve } from "@kerby/serve";
import { type ControlConfig, loadControlConfig } from "./config/index.ts";
import { createControlApp } from "./runtime/http.ts";
import { startNightly } from "./runtime/nightly.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import type { ControlDeps } from "./types/index.ts";

export { createControlApp } from "./runtime/http.ts";
export type { ControlDeps } from "./types/index.ts";
export type { ControlConfig };

/** Build the adapters for `config`, prepare the databases, and listen. */
export async function startControl(config: ControlConfig) {
  configureAlerts({
    service: "control",
    environment: config.railwayEnvironmentName,
    webhookUrl: config.alertWebhookUrl,
  });
  const control = createControlDb(config.controlDatabaseUrl);
  await migrate(control, [controlMigrationsDir]);
  if (config.appDatabasePassword) await setAppRolePassword(control, config.appDatabasePassword);
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
    async resolveUrl(tenantId) {
      const tenant = await getTenant(control, tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} does not exist`);
      return tenantDbUrl(tenant, config.tenantDbSecret, config.tenantDbSslmode);
    },
  });
  const deps: ControlDeps = {
    control,
    cluster,
    buckets,
    now: () => new Date(),
    pools,
    settings: {
      clusterHost: config.clusterHost,
      clusterPort: config.clusterPort,
      tenantDbSecret: config.tenantDbSecret,
      tenantDbSslmode: config.tenantDbSslmode,
      templateDatabase: config.templateDatabase,
      pgDumpPath: config.pgDumpPath,
    },
  };
  await ensureTemplate(deps);
  await restrictClusterDatabases(deps);
  const server = await serve(createControlApp(deps, config.operatorToken), {
    host: config.host,
    port: config.port,
  });
  const nightly = startNightly(deps);
  log("info", "control listening", { port: server.port });
  return {
    port: server.port,
    deps,
    async close() {
      await server.close();
      await nightly.stop();
      await pools.close();
      await cluster.close();
      await control.close();
      await flushAlerts();
    },
  };
}

if (import.meta.main) {
  const running = await startControl(loadControlConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
