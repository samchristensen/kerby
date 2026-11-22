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
  /** `sslmode` for tenant database URLs (`verify-full` on RDS); omit for a local, unencrypted Postgres. */
  tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
  /** An administrative URL on the cluster that holds tenant databases (CREATEDB, CREATEROLE). */
  clusterAdminUrl: z.string().min(1),
  /** Where services reach tenant databases: written into each tenant's row. */
  clusterHost: z.string().min(1),
  clusterPort: z.coerce.number().int().positive(),
  /** The database tenant databases are copied from; created and migrated at startup. */
  templateDatabase: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default("kerby_tenant_template"),
  /** A custom S3-compatible endpoint (RustFS locally). Omit on AWS: the SDK then uses S3 and the task role. */
  s3Endpoint: z.url().optional(),
  s3Region: z.string().min(1).optional(),
  s3Bucket: z.string().min(1),
  s3AccessKeyId: z.string().min(1).optional(),
  s3SecretAccessKey: z.string().min(1).optional(),
  exportDir: z.string().min(1).default("/var/lib/kerby/exports"),
  pgDumpPath: z.string().min(1).default("pg_dump"),
});

export type ControlConfig = z.output<typeof controlConfigSchema>;

export const loadControlConfig = (): ControlConfig => loadConfig(controlConfigSchema);
