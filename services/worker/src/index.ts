// The worker service: claims turns from tenant databases and runs them. This file is the composition root: it builds
// the real adapters, including the agent harness behind the AgentRuntime port.
import type { AgentRuntime } from "@kerby/agent";
import { createBlobs } from "@kerby/blobs";
import { readModelKey, readToolCredential, resolveTenantDbUrl } from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import { createEgressFetch } from "@kerby/egress";
import { createSystemOneJudgments } from "@kerby/judgment-systemone";
import { configureAlerts, flushAlerts, log } from "@kerby/observability";
import {
  createFakeModels,
  createPiDurableRuntime,
  createTenantModels,
} from "@kerby/runtime-pi-durable";
import { createOpener, createSecretBox, splitKeys } from "@kerby/secrets";
import { createRouter, json, serve } from "@kerby/serve";
import { loadWorkerConfig, type WorkerConfig } from "./config/index.ts";
import { createHandlers } from "./runtime/handlers.ts";
import { createScheduler, type Scheduler } from "./service/scheduler.ts";
import type { WorkerDeps } from "./types/index.ts";

export { createHandlers } from "./runtime/handlers.ts";
export { createScheduler } from "./service/scheduler.ts";
export type { WorkerDeps } from "./types/index.ts";

/** The development runtime: Pi Durable over the scripted fake model. Tests use it; production never does. */
export const createDevelopmentRuntime = (): AgentRuntime =>
  createPiDurableRuntime({ models: createFakeModels() });

/** One MCP exchange, listing or call, from the first byte sent to the last read (ADR 0019). */
const TOOL_CALL_TIMEOUT_MS = 60_000;

async function startWorker(config: WorkerConfig): Promise<{
  scheduler: Scheduler;
  deps: WorkerDeps;
  close(): Promise<void>;
}> {
  configureAlerts({
    service: "worker",
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
  // Sealed tenant secrets open only here (ADR 0008). Tool credentials need the key even with the fake model, which
  // only stands in for the model.
  const opener = config.secretsPrivateKeys
    ? createOpener(splitKeys(config.secretsPrivateKeys))
    : undefined;
  // Real runs use the tenant's own key for the model's provider; only the development fake model needs none.
  const modelOpener = config.kerbyFakeModel ? undefined : opener;
  const deps: WorkerDeps = {
    control,
    pools,
    blobs,
    modelKeys: modelOpener
      ? (tenantId, provider) => readModelKey(control, modelOpener, tenantId, provider)
      : undefined,
    toolCredentials: opener
      ? (tenantId, serverId) => readToolCredential(control, opener, tenantId, serverId)
      : undefined,
    // Every call to a tenant's MCP server goes through the egress guard (ADR 0010): public addresses only.
    toolFetch: createEgressFetch({ timeoutMs: TOOL_CALL_TIMEOUT_MS }),
    runtime: createPiDurableRuntime({
      models: config.kerbyFakeModel ? createFakeModels() : createTenantModels,
      onReport: (type) => log("debug", "harness report", { type }),
    }),
    judgments: [
      createSystemOneJudgments(
        "typesafe",
        config.typesafeBaseUrl === undefined ? {} : { baseUrl: config.typesafeBaseUrl },
      ),
      createSystemOneJudgments(
        "opencode",
        config.opencodeSystemoneBaseUrl === undefined
          ? {}
          : { baseUrl: config.opencodeSystemoneBaseUrl },
      ),
    ],
    settings: {
      workerId: config.workerId,
      claimTimeoutSeconds: config.claimTimeoutSeconds,
      defaultMaxConcurrentTurns: config.defaultMaxConcurrentTurns,
      maxRunningTurns: config.maxRunningTurns,
      sweepIntervalMs: config.sweepIntervalSeconds * 1000,
      enableEchoTool: config.enableEchoTool,
      historyBudgetBytes: config.historyBudgetBytes,
    },
  };
  const scheduler = createScheduler(deps, createHandlers(deps));
  await scheduler.start();
  const health = await serve(createRouter([["GET", "/healthz", () => json(200, { ok: true })]]), {
    port: config.healthPort,
  });
  log("info", "worker started", { workerId: config.workerId, fakeModel: config.kerbyFakeModel });
  return {
    scheduler,
    deps,
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
  const running = await startWorker(loadWorkerConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
