// The operator API (services/control), behind the operator token. Never exposed to tenants.
import { z } from "zod";
import { type Integration, IntegrationNameSchema, IntegrationRoleSchema } from "./integrations.ts";

/**
 * Per-tenant limits. An absent key takes the deployment default (the worker's or the api's config); the numbers are
 * defaults until pricing (plan 0001, M9).
 */
export const LimitsSchema = z.object({
  /** Turns running at once for this tenant (default: the worker's `DEFAULT_MAX_CONCURRENT_TURNS`, 4). */
  maxConcurrentTurns: z.number().int().positive().optional(),
  /**
   * Authenticated requests per minute, per api process (default `DEFAULT_REQUESTS_PER_MINUTE`, 600): a token bucket
   * that bursts up to a minute's worth. Approximate: with N api processes a tenant gets up to N times this.
   */
  requestsPerMinute: z.number().int().positive().optional(),
  /**
   * Bytes of stored objects (the tenant's blob index), checked when a message is posted (default
   * `DEFAULT_STORAGE_BYTES`, 1 GiB). A turn already admitted finishes even if its answer goes over.
   */
  storageBytes: z.number().int().positive().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

const TenantStatusSchema = z.enum(["provisioning", "active", "suspended", "deleting", "deleted"]);

const TenantSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: TenantStatusSchema,
  plan: z.string(),
  limits: LimitsSchema,
  region: z.string(),
  schemaVersion: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Tenant = z.infer<typeof TenantSchema>;

const ApiKeySchema = z.object({
  id: z.string(),
  /** The integration the key belongs to; the key may do what its role allows (ADR 0019). */
  integrationId: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** A tenant's name: unique among live tenants, chosen at provisioning (by an operator, or at sign-up in the console). */
export const TenantNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

export const CreateTenantRequestSchema = z.object({
  name: TenantNameSchema,
  plan: z.string().min(1).optional(),
  limits: LimitsSchema.optional(),
});

/** The key's secret is returned once, here, and never again. */
const CreateTenantResponseSchema = z.object({
  tenant: TenantSchema,
  apiKey: ApiKeySchema,
  secret: z.string(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

export const CreateKeyRequestSchema = z.object({
  label: z.string().max(100).optional(),
  /** One of the tenant's live integrations (default: its `default` integration). */
  integrationId: z.uuid().optional(),
});

/** `POST /v1/operator/tenants/:id/integrations`. */
export const CreateIntegrationRequestSchema = z.object({
  name: IntegrationNameSchema,
  role: IntegrationRoleSchema,
});
export type CreateIntegrationResponse = { integration: Integration };

const CreateKeyResponseSchema = z.object({ apiKey: ApiKeySchema, secret: z.string() });
export type CreateKeyResponse = z.infer<typeof CreateKeyResponseSchema>;

const ListKeysResponseSchema = z.object({ keys: z.array(ApiKeySchema) });
export type ListKeysResponse = z.infer<typeof ListKeysResponseSchema>;

const ListTenantsResponseSchema = z.object({ tenants: z.array(TenantSchema) });
export type ListTenantsResponse = z.infer<typeof ListTenantsResponseSchema>;

const ExportResponseSchema = z.object({
  /** Downloads a `pg_dump` custom-format file of the tenant's database, without credentials, until `expiresAt`. */
  dumpUrl: z.url(),
  /** Downloads the tenant's object keys and sizes, as JSON, until `expiresAt`. */
  objectsUrl: z.url(),
  expiresAt: z.iso.datetime(),
  objectPrefix: z.string(),
  objectCount: z.number().int().nonnegative(),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

/** Reissue the URLs of an export that exists: the tenant's newest, or the one stamped `stamp` (as in its file names). */
export const ReissueExportRequestSchema = z.object({
  stamp: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
    .optional(),
});

/** Without `objectCount`: counting means downloading the listing, which can be large; `objectsUrl` has it. */
const ReissueExportResponseSchema = ExportResponseSchema.omit({ objectCount: true }).extend({
  /** When the export was made. */
  exportedAt: z.iso.datetime(),
});
export type ReissueExportResponse = z.infer<typeof ReissueExportResponseSchema>;

const BackupFailureSchema = z.object({ tenantId: z.uuid(), error: z.string() });

/** One run of the bucket backup: changed objects of every live tenant copied, deleted tenants' copies removed. */
const BackupResponseSchema = z.object({
  tenants: z.number().int().nonnegative(),
  copied: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  deletedTenants: z.number().int().nonnegative(),
  objectsDeleted: z.number().int().nonnegative(),
  failed: z.array(BackupFailureSchema),
  durationMs: z.number().int().nonnegative(),
});
export type BackupResponse = z.infer<typeof BackupResponseSchema>;

/** Restore one tenant's objects from the backup, or every live tenant's when `tenantId` is absent. */
export const RestoreRequestSchema = z.object({ tenantId: z.uuid().optional() });

/** Only objects missing from the primary bucket are copied back; nothing there is overwritten. */
const RestoreResponseSchema = z.object({
  tenants: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  failed: z.array(BackupFailureSchema),
  durationMs: z.number().int().nonnegative(),
});
export type RestoreResponse = z.infer<typeof RestoreResponseSchema>;
