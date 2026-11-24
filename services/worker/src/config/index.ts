import { hostname } from "node:os";
import { loadConfig } from "@kerby/config";
import { z } from "zod";

export const workerConfigSchema = z
  .object({
    controlDatabaseUrl: z.string().min(1),
    /** Opens tenants' stored database passwords (ADR 0009): the launcher derives it from KERBY_SECRET_KEY. */
    tenantDbKeys: z.string().min(1),
    /** `sslmode` for tenant database URLs; omit for a Postgres on a private network or locally, which does not use TLS. */
    tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
    /** The S3-compatible endpoint: a Railway bucket, or RustFS locally. */
    s3Endpoint: z.url(),
    s3Region: z.string().min(1).optional(),
    s3Bucket: z.string().min(1),
    s3AccessKeyId: z.string().min(1),
    s3SecretAccessKey: z.string().min(1),
    /** Where alerts are posted: Slack, Discord or any JSON webhook (docs/deploy.md#alerts). Unset or empty: log lines only. */
    alertWebhookUrl: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url({ protocol: /^https?$/ }).optional(),
    ),
    /** Set by Railway on every deployment; names the environment in alerts. */
    railwayEnvironmentName: z.string().min(1).optional(),
    /** Names this worker in Absurd's run rows. */
    workerId: z
      .string()
      .min(1)
      .default(() => `${hostname()}:${process.pid}`),
    /** `development` allows the scripted fake model; `production` (the default) refuses it. */
    kerbyEnvironment: z.enum(["development", "production"]).default("production"),
    /** Answer with the scripted fake model instead of a real provider (local stacks and end-to-end tests). */
    kerbyFakeModel: z.stringbool().default(false),
    /**
     * Make the built-in `kerby/echo` tool available (development). Like every tool, it is offered only to a
     * conversation that names it; where this is off, the worker leaves it out of a turn.
     */
    enableEchoTool: z.stringbool().default(false),
    /**
     * How long one call to a tenant's MCP tool may take, from the first byte sent to the last read; past it the model
     * reads an error result (ADR 0022). Also bounds every exchange through the egress guard. Default 60 s.
     */
    toolCallTimeoutMs: z.coerce.number().int().positive().default(60_000),
    /**
     * Host names the egress guard lets through although they resolve to private addresses, comma separated: the
     * install's own MCP servers on its private network (`crm.railway.internal`, a Compose service name) or this machine
     * (ADR 0010, amended by 0024). The api has the same setting.
     */
    egressAllowedHosts: z
      .string()
      .default("")
      .transform((hosts) =>
        hosts
          .split(",")
          .map((host) => host.trim())
          .filter((host) => host !== ""),
      ),
    /**
     * Private key(s) that open tenants' sealed model keys, base64, comma separated: the key new secrets are sealed
     * to first, older ones after it while a rotation finishes. Not needed with the fake model.
     */
    secretsPrivateKeys: z.string().min(1).optional(),
    /** TypeSafe's API (judgments, ADR 0015). Unset: https://api.typesafe.ai. Local stacks and tests point it at a stand-in. */
    typesafeBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
    /** OpenCode Console's System One gateway (judgments, ADR 0015). Unset: https://opencode.ai/inference/systemone. */
    opencodeSystemoneBaseUrl: z.url({ protocol: /^https?$/ }).optional(),
    /** Port of the liveness endpoint (`GET /healthz`) for the container health check. */
    healthPort: z.coerce.number().int().min(0).default(8082),
    /** How often to look at the tenants whose work is due (hinted by the api, or a retry's or lease's time come). */
    sweepIntervalSeconds: z.coerce.number().positive().default(10),
    /**
     * How often to look at every active tenant, the backstop for a hint lost between the api's commit and its write.
     * Also done at start and when the control connection's LISTEN reconnects.
     */
    fullSweepIntervalSeconds: z.coerce.number().positive().default(300),
    /** Lease length; a heartbeat extends it for as long as a turn runs. */
    claimTimeoutSeconds: z.coerce.number().int().positive().default(120),
    /**
     * Bytes of message bodies a turn is rehydrated with (sizes from the tenant's blob index). Past it the oldest whole
     * turns are left out, cut before a user message, so the model sees the newest context and a worker's memory per
     * turn is bounded. The turn being answered is always whole. Default 8 MiB.
     */
    historyBudgetBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),
    /** Turns one tenant may run at once on this worker when its limits do not say. */
    defaultMaxConcurrentTurns: z.coerce.number().int().positive().default(4),
    /**
     * Turns this worker runs at once across all tenants. Each running turn holds its tenant's pool of 2 connections,
     * so this bounds the worker's tenant connections to 2 × this (docs/deploy.md#postgres). Default 50, the pool
     * count the budget is sized for. Past it a worker claims nothing more and waiting tenants are served in turn.
     */
    maxRunningTurns: z.coerce.number().int().positive().default(50),
    /**
     * Index tasks (ADR 0021) this worker runs at once across all tenants, one per tenant. Each holds its tenant's pool
     * like a turn, so it adds to the worker's connection budget (docs/deploy.md#postgres). Default 2: indexing may lag
     * behind turns; it never takes their slots.
     */
    maxRunningIndexTasks: z.coerce.number().int().positive().default(2),
    /**
     * Searches (ADR 0021) this worker runs at once across all tenants, up to 4 per tenant. Each holds its tenant's pool
     * while it embeds the query, so it adds to the worker's connection budget (docs/deploy.md#postgres). Default 4.
     */
    maxRunningSearches: z.coerce.number().int().positive().default(4),
  })
  .refine((config) => config.kerbyFakeModel || config.secretsPrivateKeys !== undefined, {
    message:
      "SECRETS_PRIVATE_KEYS is required: tenants bring their own model keys and only a worker can open them",
    path: ["secretsPrivateKeys"],
  })
  .refine((config) => !(config.kerbyFakeModel && config.kerbyEnvironment === "production"), {
    message: "KERBY_FAKE_MODEL is only allowed with KERBY_ENVIRONMENT=development",
    path: ["kerbyFakeModel"],
  });

export type WorkerConfig = z.output<typeof workerConfigSchema>;

export const loadWorkerConfig = (): WorkerConfig => loadConfig(workerConfigSchema);
