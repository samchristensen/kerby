// The control service: the operator API. This file is the composition root: it builds the real adapters.
import { createBlobs } from "@kerby/blobs";
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
import { ensureTemplate } from "./service/template.ts";
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
  const blobs = createBlobs({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  });
  await blobs.ensureBucket();
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
    blobs,
    pools,
    settings: {
      clusterHost: config.clusterHost,
      clusterPort: config.clusterPort,
      tenantDbSecret: config.tenantDbSecret,
      tenantDbSslmode: config.tenantDbSslmode,
      templateDatabase: config.templateDatabase,
      exportDir: config.exportDir,
      pgDumpPath: config.pgDumpPath,
    },
  };
  await ensureTemplate(deps);
  const server = await serve(createControlApp(deps, config.operatorToken), {
    host: config.host,
    port: config.port,
  });
  log("info", "control listening", { port: server.port });
  return {
    port: server.port,
    deps,
    async close() {
      await server.close();
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
