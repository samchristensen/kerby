// The dispatcher service (ADR 0019): fans tenants' events out to their subscriptions and delivers them. This file is the
// composition root: it builds the real adapters, including every destination kind behind the Destination port.
import { resolveTenantDbUrl } from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import type { Destinations } from "@kerby/delivery";
import { createWebhookDestination } from "@kerby/delivery-webhook";
import { createEgressFetch } from "@kerby/egress";
import { configureAlerts, flushAlerts, log } from "@kerby/observability";
import { createOpener, createSecretBox, splitKeys } from "@kerby/secrets";
import { createRouter, json, serve } from "@kerby/serve";
import { type DispatcherConfig, loadDispatcherConfig } from "./config/index.ts";
import { createHandlers } from "./runtime/handlers.ts";
import { createScheduler } from "./service/scheduler.ts";
import type { DispatcherDeps } from "./types/index.ts";

export { dispatcherConfigSchema } from "./config/index.ts";
export { createHandlers } from "./runtime/handlers.ts";
export { createScheduler } from "./service/scheduler.ts";
export type { DispatcherDeps } from "./types/index.ts";

/**
 * Every destination kind. `allowLocal` (development, and tests) lets plain http and private addresses through, so a
 * receiver on this machine works; otherwise only https to public addresses, through the egress guard (ADR 0010).
 */
export function createDestinations(allowLocal: boolean): Destinations {
  const fetch = createEgressFetch({
    timeoutMs: 10_000,
    ...(allowLocal ? { blockedRanges: [] } : {}),
  });
  return { webhook: createWebhookDestination({ fetch, allowLocal }) };
}

async function startDispatcher(config: DispatcherConfig): Promise<{ close(): Promise<void> }> {
  configureAlerts({
    service: "dispatcher",
    environment: config.railwayEnvironmentName,
    webhookUrl: config.alertWebhookUrl,
  });
  // The connection budget (docs/deploy.md#postgres): 5 control connections, one LISTEN, and at most 20 tenant pools
  // of 2.
  const control = createControlDb(config.controlDatabaseUrl, { max: 5 });
  const tenantDbBox = createSecretBox(splitKeys(config.tenantDbKeys), "TENANT_DB_KEYS key");
  const pools = new TenantPools({
    resolveUrl: (tenantId) =>
      resolveTenantDbUrl(control, tenantDbBox, tenantId, config.tenantDbSslmode),
    maxPools: 20,
  });
  const deps: DispatcherDeps = {
    control,
    pools,
    opener: createOpener(splitKeys(config.deliverySecretsPrivateKeys)),
    destinations: createDestinations(config.allowLocalDestinations),
    settings: {
      workerId: config.workerId,
      claimTimeoutSeconds: config.claimTimeoutSeconds,
      defaultConcurrentDeliveries: config.defaultConcurrentDeliveries,
      maxRunningDeliveries: config.maxRunningDeliveries,
      sweepIntervalMs: config.sweepIntervalSeconds * 1000,
    },
  };
  const scheduler = createScheduler(deps, createHandlers(deps));
  await scheduler.start();
  const health = await serve(createRouter([["GET", "/healthz", () => json(200, { ok: true })]]), {
    port: config.healthPort,
  });
  log("info", "dispatcher started", {
    workerId: config.workerId,
    allowLocalDestinations: config.allowLocalDestinations,
  });
  return {
    async close() {
      await scheduler.stop();
      await health.close();
      await pools.close();
      await control.close();
      await flushAlerts();
    },
  };
}

if (import.meta.main) {
  const running = await startDispatcher(loadDispatcherConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
