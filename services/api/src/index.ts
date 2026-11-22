// The tenant-facing API service. This file is the composition root: it builds the real adapters.
import { createBlobs } from "@kerby/blobs";
import { getTenant, tenantDbUrl } from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import { log } from "@kerby/observability";
import { serve } from "@kerby/serve";
import { type ApiConfig, loadApiConfig } from "./config/index.ts";
import { createApiApp } from "./runtime/http.ts";
import type { ApiDeps } from "./types/index.ts";

export { createApiApp } from "./runtime/http.ts";
export type { ApiDeps } from "./types/index.ts";
export type { ApiConfig };

export async function startApi(config: ApiConfig) {
  const control = createControlDb(config.controlDatabaseUrl);
  const blobs = createBlobs({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    credentials:
      config.s3AccessKeyId && config.s3SecretAccessKey
        ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
        : undefined,
  });
  const pools = new TenantPools({
    async resolveUrl(tenantId) {
      const tenant = await getTenant(control, tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} does not exist`);
      return tenantDbUrl(tenant, config.tenantDbSecret, config.tenantDbSslmode);
    },
  });
  const deps: ApiDeps = {
    control,
    pools,
    blobs,
    settings: {
      models: config.models,
      defaultSystem: config.defaultSystem,
      authCacheMs: config.authCacheSeconds * 1000,
    },
  };
  const server = await serve(createApiApp(deps), { host: config.host, port: config.port });
  log("info", "api listening", { port: server.port });
  return {
    port: server.port,
    deps,
    async close() {
      await server.close();
      await pools.close();
      await control.close();
    },
  };
}

if (import.meta.main) {
  const running = await startApi(loadApiConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
