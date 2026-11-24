import { loadConfig } from "@kerby/config";
import { EmailSchema, TenantNameSchema } from "@kerby/contracts";
import { z } from "zod";

/** An unset variable often arrives as "": the same as absent. */
const blankIsAbsent = (value: unknown) => (value === "" ? undefined : value);

const controlConfigSchema = z
  .object({
    /** Where control answers its health; the launcher waits on it and nothing else calls it (127.0.0.1 there). */
    host: z.string().default("0.0.0.0"),
    port: z.coerce.number().int().min(0).default(8081),
    /** The control database, as a superuser of Kerby's own Postgres. */
    controlDatabaseUrl: z.string().min(1),
    /**
     * Keys sealing every tenant database role's password (ADR 0009): base64 32-byte keys, comma separated; the first
     * seals, every one opens. The launcher derives it from KERBY_SECRET_KEY; api, worker and dispatcher get the same.
     */
    tenantDbKeys: z.string().min(1),
    /** `sslmode` for tenant database URLs; omit for a Postgres on a private network or locally, which does not use TLS. */
    tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
    /** An administrative URL, as a superuser, on the cluster's maintenance database (`postgres`). */
    clusterAdminUrl: z.string().min(1),
    /** Where services reach tenant databases: written into each tenant's row. */
    clusterHost: z.string().min(1),
    clusterPort: z.coerce.number().int().positive(),
    /** Password for the limited `kerby_app` role api, worker and dispatcher use on the control database. */
    appDatabasePassword: z.string().min(16).optional(),
    /** Password for the limited `kerby_console` role the console uses on the control database. */
    consoleDatabasePassword: z.string().min(16).optional(),
    /** The database tenant databases are copied from; created and migrated at startup. */
    templateDatabase: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .default("kerby_tenant_template"),
    /** The bucket holding every tenant's objects: a Railway bucket, or RustFS locally. Created at startup if missing. */
    s3Endpoint: z.url(),
    s3Region: z.string().min(1).optional(),
    s3Bucket: z.string().min(1),
    s3AccessKeyId: z.string().min(1),
    s3SecretAccessKey: z.string().min(1),
    /** Where alerts are posted: Slack, Discord or any JSON webhook (docs/deploy.md#alerts). Unset or empty: log lines only. */
    alertWebhookUrl: z.preprocess(blankIsAbsent, z.url({ protocol: /^https?$/ }).optional()),
    /** Set by Railway on every deployment; names the environment in alerts. */
    railwayEnvironmentName: z.string().min(1).optional(),
    /** The install's tenant's name, used when control first makes it (ADR 0024). */
    kerbyTenantName: TenantNameSchema.default("default"),
    /**
     * The tenant's configured API key, `kb_<12 hex>_<43 base64url>` (`make secrets-key` makes one), with every scope.
     * Control keeps it live at every start and revokes the one configured before it.
     */
    kerbyApiKey: z.preprocess(blankIsAbsent, z.string().optional()),
    /** The console's one account: made at the first start, its password reset whenever this one changes. */
    kerbyAdminEmail: z.preprocess(blankIsAbsent, EmailSchema.optional()),
    kerbyAdminPassword: z.preprocess(
      blankIsAbsent,
      z.string().min(10, "at least 10 characters").max(200, "at most 200 characters").optional(),
    ),
  })
  .refine(
    (config) =>
      (config.kerbyAdminEmail === undefined) === (config.kerbyAdminPassword === undefined),
    {
      message: "set KERBY_ADMIN_EMAIL and KERBY_ADMIN_PASSWORD together, or neither",
      path: ["kerbyAdminPassword"],
    },
  )
  .refine((config) => config.kerbyApiKey !== undefined || config.kerbyAdminEmail !== undefined, {
    message:
      "set KERBY_API_KEY, or KERBY_ADMIN_EMAIL and KERBY_ADMIN_PASSWORD, or both: otherwise nothing can reach this install",
    path: ["kerbyApiKey"],
  });

export type ControlConfig = z.output<typeof controlConfigSchema>;

export const loadControlConfig = (): ControlConfig => loadConfig(controlConfigSchema);
