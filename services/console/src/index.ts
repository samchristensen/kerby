// The tenant console: Next.js pages over the control plane (ADR 0014). This file is the composition root: it reads the
// config, builds the real adapters natively (Next.js never bundles them) and installs the service the pages call.
import { join } from "node:path";
import { kerbyOAuthClient } from "@kerby/contracts";
import { PASSWORD_COST } from "@kerby/control-plane";
import { createControlDb, postgresUrl } from "@kerby/db";
import { JUDGMENT_PROVIDERS } from "@kerby/judgment-systemone/providers";
import { log } from "@kerby/observability";
import { SUPPORTED_PROVIDERS } from "@kerby/runtime-pi-durable/providers";
import { createSealer, deriveInstanceKeys } from "@kerby/secrets";
import { installConsole } from "./app/_lib/console.ts";
import { type ConsoleConfig, loadConsoleConfig } from "./config/index.ts";
import { createApiClient } from "./runtime/api-client.ts";
import { startServer } from "./runtime/server.ts";
import { createConsoleService } from "./service/index.ts";

const SESSION_TTL_MS = 7 * 24 * 3_600_000;

async function startConsole(config: ConsoleConfig) {
  const keys = deriveInstanceKeys(config.kerbySecretKey);
  const control = createControlDb(
    postgresUrl(config.databaseUrl, {
      role: "kerby_console",
      password: keys.consoleDatabasePassword,
    }),
    { max: 5 },
  );
  installConsole({
    service: createConsoleService({
      control,
      sealer: createSealer(keys.secrets.publicKey),
      api: createApiClient(config.apiUrl),
      settings: {
        // The adapters own the provider lists (ADR 0008, 0015); their `providers` subpaths load no adapter code.
        modelProviders: SUPPORTED_PROVIDERS,
        judgmentProviders: JUDGMENT_PROVIDERS,
        apiPublicUrl: config.apiPublicUrl,
        sessionTtlMs: SESSION_TTL_MS,
        passwordCost: PASSWORD_COST,
        failedLoginsPerMinute: config.failedLoginsPerMinute,
        failedLoginsPerAccountPerHour: config.failedLoginsPerAccountPerHour,
      },
    }),
    secureCookies: config.secureCookies,
  });
  const server = await startServer({
    host: config.host,
    port: config.port,
    dir: join(import.meta.dirname, ".."),
    dev: config.devServer,
    trustProxy: config.trustProxy,
    clientMetadata:
      config.publicUrl === undefined ? undefined : kerbyOAuthClient(config.publicUrl).metadata,
  });
  log("info", "console listening", { port: server.port, dev: config.devServer });
  return {
    async close() {
      await server.close();
      await control.close();
    },
  };
}

if (import.meta.main) {
  const running = await startConsole(loadConsoleConfig());
  const stop = () => void running.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
