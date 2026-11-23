// The tenant-facing API service. This file is the composition root: it builds the real adapters.
import { createBlobs } from "@kerby/blobs";
import { resolveTenantDbUrl } from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import type { Destinations } from "@kerby/delivery";
import { createWebhookDestination } from "@kerby/delivery-webhook";
import { createEgressFetch } from "@kerby/egress";
import { JUDGMENT_PROVIDERS } from "@kerby/judgment-systemone/providers";
import { configureAlerts, flushAlerts, log } from "@kerby/observability";
import { SUPPORTED_PROVIDERS } from "@kerby/runtime-pi-durable/providers";
import { createSealer, createSecretBox, splitKeys } from "@kerby/secrets";
import { serve } from "@kerby/serve";
import { type ApiConfig, loadApiConfig } from "./config/index.ts";
import { createApiApp } from "./runtime/http.ts";
import type { ApiDeps } from "./types/index.ts";

export { createApiApp } from "./runtime/http.ts";

/**
 * Every destination kind's adapter, built as the dispatcher builds them so both refuse the same destinations. The api
 * only makes secrets and checks configs with them, and never delivers. `allowLocal`: http URLs and private addresses.
 */
export function createDestinations(allowLocal: boolean): Destinations {
  return {
    webhook: createWebhookDestination({
      fetch: createEgressFetch({ timeoutMs: 10_000, ...(allowLocal ? { blockedRanges: [] } : {}) }),
      allowLocal,
    }),
  };
}

async function startApi(config: ApiConfig) {
  configureAlerts({
    service: "api",
    environment: config.railwayEnvironmentName,
    webhookUrl: config.alertWebhookUrl,
  });
  const control = createControlDb(config.controlDatabaseUrl);
  const blobs = createBlobs({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  });
  const tenantDbBox = createSecretBox(splitKeys(config.tenantDbKeys), "TENANT_DB_KEYS key");
  const pools = new TenantPools({
    resolveUrl: (tenantId) =>
      resolveTenantDbUrl(control, tenantDbBox, tenantId, config.tenantDbSslmode),
  });
  const deps: ApiDeps = {
    control,
    pools,
    blobs,
    sealer: createSealer(config.secretsPublicKey),
    deliverySealer: createSealer(config.deliverySecretsPublicKey),
    destinations: createDestinations(config.allowLocalDestinations),
    settings: {
      defaultModel: config.defaultModel,
      // The adapters own the provider lists (ADR 0008, 0015); their `providers` subpaths load no adapter code.
      modelProviders: SUPPORTED_PROVIDERS,
      judgmentProviders: JUDGMENT_PROVIDERS,
      keylessProviders: config.keylessProviders,
      defaultSystem: config.defaultSystem,
      authCacheMs: config.authCacheSeconds * 1000,
      maxStreamsPerTenant: config.maxStreamsPerTenant,
      maxStreamsPerProcess: config.maxStreamsPerProcess,
      streamRecheckMs: 5000,
      defaultRequestsPerMinute: config.defaultRequestsPerMinute,
      defaultStorageBytes: config.defaultStorageBytes,
      failedAuthPerMinute: config.failedAuthPerMinute,
      trustProxy: config.trustProxy,
      defaultSubscriptions: config.defaultSubscriptions,
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
      await flushAlerts();
    },
  };
}

if (import.meta.main) {
  const running = await startApi(loadApiConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
