import { loadConfig } from "@kerby/config";
import { z } from "zod";

const apiConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(8080),
  controlDatabaseUrl: z.string().min(1),
  /** Opens tenants' stored database passwords (ADR 0009): the same comma-separated key list control holds. */
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
  /** Public key tenants' model keys are sealed to (base64); the private half stays with the workers. `make secrets-key` makes a pair. */
  secretsPublicKey: z.string().min(1),
  /** Model for a conversation whose request names none, `<provider>/<modelId>`. Optional: without it a request names its model. */
  defaultModel: z.string().min(1).optional(),
  /** Providers that need no tenant key, comma separated: only `fake`, in development. */
  keylessProviders: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  defaultSystem: z.string().default("You are a helpful assistant."),
  /** How long a verified key is trusted: also how long suspension and revocation take to bite. */
  authCacheSeconds: z.coerce.number().int().min(0).default(30),
  /**
   * Event streams one tenant may hold open on this process. A tenant's streams share its pool and listening connection,
   * so this cap only keeps one tenant from taking the whole process cap: a quarter of it (docs/deploy.md#postgres).
   */
  maxStreamsPerTenant: z.coerce.number().int().positive().default(15),
  /**
   * Event streams this process holds open in all. Each distinct tenant among them costs 3 connections (its pool of 2
   * and its listener): size it from the budget in docs/deploy.md#postgres.
   */
  maxStreamsPerProcess: z.coerce.number().int().positive().default(60),
  /**
   * Requests per minute for a tenant whose limits do not say (`limits.requestsPerMinute`). A token bucket per api
   * process: with N processes a tenant gets up to N times this. A default until pricing (plan 0001, M9).
   */
  defaultRequestsPerMinute: z.coerce.number().int().positive().default(600),
  /** Bytes a tenant may store when its limits do not say (`limits.storageBytes`); default 1 GiB, until pricing. */
  defaultStorageBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  /** Failed authentications one client address may make per minute; past it the address gets 429 without a lookup. */
  failedAuthPerMinute: z.coerce.number().int().positive().default(30),
  /**
   * The api sits behind a proxy that writes `X-Forwarded-For` (Railway's edge): the client address is its left-most
   * entry. Off (the default), the socket's address is the client and the header is ignored, since anyone can send it.
   */
  trustProxy: z.stringbool().default(false),
  /** Let conversations name the built-in `kerby/echo` tool (development); the worker has the same setting. */
  enableEchoTool: z.stringbool().default(false),
});

export type ApiConfig = z.output<typeof apiConfigSchema>;

export const loadApiConfig = (): ApiConfig => loadConfig(apiConfigSchema);
