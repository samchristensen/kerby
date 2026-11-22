import { loadConfig } from "@kerby/config";
import { z } from "zod";

export const apiConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(8080),
  controlDatabaseUrl: z.string().min(1),
  /** See `tenantDbPassword`: the same secret the control service provisions roles with. */
  tenantDbSecret: z.string().min(16),
  /** `sslmode` for tenant database URLs; omit for a Postgres on a private network or locally, which does not use TLS. */
  tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
  /** The S3-compatible endpoint: a Railway bucket, or RustFS locally. */
  s3Endpoint: z.url(),
  s3Region: z.string().min(1).optional(),
  s3Bucket: z.string().min(1),
  s3AccessKeyId: z.string().min(1),
  s3SecretAccessKey: z.string().min(1),
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
  /** Event streams one tenant may hold open on this process (each keeps a database connection). */
  maxStreamsPerTenant: z.coerce.number().int().positive().default(20),
  authCacheSeconds: z.coerce.number().int().min(0).default(30),
});

export type ApiConfig = z.output<typeof apiConfigSchema>;

export const loadApiConfig = (): ApiConfig => loadConfig(apiConfigSchema);
