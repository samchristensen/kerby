import { loadConfig } from "@kerby/config";
import { z } from "zod";

export const controlConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(8081),
  /** The control database. */
  controlDatabaseUrl: z.string().min(1),
  /** Bearer token for the operator API. */
  operatorToken: z.string().min(16),
  /** Derives every tenant database role's password (ADR 0004). All services that open tenant databases share it. */
  tenantDbSecret: z.string().min(16),
  /** `sslmode` for tenant database URLs; omit for a Postgres on a private network or locally, which does not use TLS. */
  tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
  /** An administrative URL on the cluster that holds tenant databases (CREATEDB, CREATEROLE). */
  clusterAdminUrl: z.string().min(1),
  /** Where services reach tenant databases: written into each tenant's row. */
  clusterHost: z.string().min(1),
  clusterPort: z.coerce.number().int().positive(),
  /** Password for the limited `kerby_app` role api and worker use on the control database. Omit locally. */
  appDatabasePassword: z.string().min(16).optional(),
  /** The database tenant databases are copied from; created and migrated at startup. */
  templateDatabase: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default("kerby_tenant_template"),
  /** The primary bucket, holding every tenant's objects: a Railway bucket, or RustFS locally. */
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
  /** The export bucket: only control holds its keys. */
  exportS3Endpoint: z.url(),
  exportS3Region: z.string().min(1).optional(),
  exportS3Bucket: z.string().min(1),
  exportS3AccessKeyId: z.string().min(1),
  exportS3SecretAccessKey: z.string().min(1),
  /** The backup bucket, a copy of the primary's `t/` in another region: only control holds its keys. */
  backupS3Endpoint: z.url(),
  backupS3Region: z.string().min(1).optional(),
  backupS3Bucket: z.string().min(1),
  backupS3AccessKeyId: z.string().min(1),
  backupS3SecretAccessKey: z.string().min(1),
  pgDumpPath: z.string().min(1).default("pg_dump"),
});

export type ControlConfig = z.output<typeof controlConfigSchema>;

export const loadControlConfig = (): ControlConfig => loadConfig(controlConfigSchema);
