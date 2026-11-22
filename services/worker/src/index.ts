// The worker service: claims turns from tenant databases and runs them. This file is the composition root: it builds
// the real adapters, including the agent harness behind the AgentRuntime port.
import type { AgentRuntime } from "@kerby/agent";
import { createBlobs } from "@kerby/blobs";
import { getTenant, tenantDbUrl } from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import { log } from "@kerby/observability";
import {
  createFakeModels,
  createPiDurableRuntime,
  createProviderModels,
} from "@kerby/runtime-pi-durable";
import { createRouter, json, serve } from "@kerby/serve";
import { loadWorkerConfig, type WorkerConfig } from "./config/index.ts";
import { createHandlers } from "./runtime/handlers.ts";
import { createScheduler, type Scheduler } from "./service/scheduler.ts";
import type { WorkerDeps } from "./types/index.ts";

export { createHandlers } from "./runtime/handlers.ts";
export type { Scheduler } from "./service/scheduler.ts";
export { createScheduler } from "./service/scheduler.ts";
export { runTurn } from "./service/turn.ts";
export type { WorkerDeps } from "./types/index.ts";
export type { WorkerConfig };

/** The development runtime: Pi Durable over the scripted fake model. Tests use it; production never does. */
export const createDevelopmentRuntime = (): AgentRuntime =>
  createPiDurableRuntime({ models: createFakeModels() });

export async function startWorker(config: WorkerConfig): Promise<{
  scheduler: Scheduler;
  deps: WorkerDeps;
  close(): Promise<void>;
}> {
  const control = createControlDb(config.controlDatabaseUrl);
  const blobs = createBlobs({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    bucket: config.s3Bucket,
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  });
  const pools = new TenantPools({
    async resolveUrl(tenantId) {
      const tenant = await getTenant(control, tenantId);
      if (!tenant) throw new Error(`tenant ${tenantId} does not exist`);
      return tenantDbUrl(tenant, config.tenantDbSecret, config.tenantDbSslmode);
    },
  });
  const models = config.kerbyFakeModel
    ? createFakeModels()
    : createProviderModels({
        anthropicApiKey: config.anthropicApiKey,
        openaiApiKey: config.openaiApiKey,
      });
  const deps: WorkerDeps = {
    control,
    pools,
    blobs,
    runtime: createPiDurableRuntime({
      models,
      onReport: (type) => log("debug", "harness report", { type }),
    }),
    settings: {
      workerId: config.workerId,
      claimTimeoutSeconds: config.claimTimeoutSeconds,
      defaultMaxConcurrentTurns: config.defaultMaxConcurrentTurns,
      sweepIntervalMs: config.sweepIntervalSeconds * 1000,
      enableEchoTool: config.enableEchoTool,
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
    },
  };
}

if (import.meta.main) {
  const running = await startWorker(loadWorkerConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
