// The worker service: claims turns from tenant databases and runs them. This file is the composition root: it builds
// the real adapters, including the agent harness behind the AgentRuntime port.
import type { AgentRuntime } from "@kerby/agent";
import { createBlobs } from "@kerby/blobs";
import {
  readModelKey,
  readToolCredential,
  resolveTenantDbUrl,
  updateToolCredential,
} from "@kerby/control-plane";
import { createControlDb, TenantPools } from "@kerby/db";
import { type BlockedRange, createEgressFetch } from "@kerby/egress";
import { createFakeEmbeddings } from "@kerby/embeddings/fake";
import { createOpenAiEmbeddings } from "@kerby/embeddings-openai";
import { EMBEDDING_PROVIDERS } from "@kerby/embeddings-openai/providers";
import { createSystemOneJudgments } from "@kerby/judgment-systemone";
import { configureAlerts, flushAlerts, log } from "@kerby/observability";
import {
  createFakeModels,
  createPiDurableRuntime,
  createTenantModels,
} from "@kerby/runtime-pi-durable";
import {
  createOpener,
  createSealer,
  createSecretBox,
  publicKeyOf,
  splitKeys,
} from "@kerby/secrets";
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

/**
 * The egress guard's `fetch`es for tenants' MCP servers (ADR 0010): public addresses only, but for the hosts a
 * development stack names (`blockedRanges` narrows the check in tests). A call's result is cut at 256 KiB, so 4 MiB of
 * response is plenty; a listing reads at most 1 MiB a page (and 4 MiB in all, counted by the sync), 30 s an exchange.
 */
export function toolFetches(options: {
  toolCallTimeoutMs: number;
  allowedHosts: readonly string[];
  blockedRanges?: readonly BlockedRange[];
}): Pick<WorkerDeps, "toolFetch" | "syncFetch"> {
  const { allowedHosts, blockedRanges } = options;
  const guard = blockedRanges === undefined ? { allowedHosts } : { allowedHosts, blockedRanges };
  return {
    toolFetch: createEgressFetch({
      ...guard,
      timeoutMs: options.toolCallTimeoutMs,
      maxResponseBytes: 4 * 1024 * 1024,
    }),
    syncFetch: createEgressFetch({ ...guard, timeoutMs: 30_000, maxResponseBytes: 1024 * 1024 }),
  };
}

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
  const privateKeys = config.secretsPrivateKeys ? splitKeys(config.secretsPrivateKeys) : [];
  const opener = privateKeys[0] === undefined ? undefined : createOpener(privateKeys);
  // A refreshed OAuth token is sealed again, to the public half of the key new secrets are sealed to (the first).
  const keys =
    opener && privateKeys[0] !== undefined
      ? { opener, sealer: createSealer(publicKeyOf(privateKeys[0])) }
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
    toolCredentials: keys
      ? {
          read: (tenantId, serverId) =>
            readToolCredential(control, keys.opener, tenantId, serverId),
          update: (tenantId, serverId, change) =>
            updateToolCredential(control, keys, tenantId, serverId, change),
        }
      : undefined,
    // Every exchange with a tenant's MCP server goes through the egress guard.
    ...toolFetches({
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      allowedHosts: config.egressAllowedHosts,
    }),
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
    // The development fake model's stack embeds with the fake too, keyless like it; real runs use the tenant's key.
    embeddings: config.kerbyFakeModel
      ? [createFakeEmbeddings()]
      : EMBEDDING_PROVIDERS.map((id) => createOpenAiEmbeddings(id)),
    settings: {
      workerId: config.workerId,
      claimTimeoutSeconds: config.claimTimeoutSeconds,
      defaultMaxConcurrentTurns: config.defaultMaxConcurrentTurns,
      maxRunningTurns: config.maxRunningTurns,
      maxRunningIndexTasks: config.maxRunningIndexTasks,
      maxRunningSearches: config.maxRunningSearches,
      sweepIntervalMs: config.sweepIntervalSeconds * 1000,
      fullSweepIntervalMs: config.fullSweepIntervalSeconds * 1000,
      enableEchoTool: config.enableEchoTool,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
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
