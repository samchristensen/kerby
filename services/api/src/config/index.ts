import { loadConfig } from "@kerby/config";
import { z } from "zod";

export const apiConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(8080),
  controlDatabaseUrl: z.string().min(1),
  /** See `tenantDbPassword`: the same secret the control service provisions roles with. */
  tenantDbSecret: z.string().min(16),
  s3Endpoint: z.url(),
  s3Bucket: z.string().min(1),
  s3AccessKeyId: z.string().min(1),
  s3SecretAccessKey: z.string().min(1),
  /** Model ids a conversation may use, comma separated; the first is the default. */
  models: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1)),
  defaultSystem: z.string().default("You are a helpful assistant."),
  /** How long a verified key is trusted: also how long suspension and revocation take to bite. */
  authCacheSeconds: z.coerce.number().int().min(0).default(30),
});

export type ApiConfig = z.output<typeof apiConfigSchema>;

export const loadApiConfig = (): ApiConfig => loadConfig(apiConfigSchema);
