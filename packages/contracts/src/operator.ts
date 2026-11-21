// The operator API (services/control), behind the operator token. Never exposed to tenants.
import { z } from "zod";

export const LimitsSchema = z.object({
  /** Turns running at once for this tenant. */
  maxConcurrentTurns: z.number().int().positive().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const TenantStatusSchema = z.enum([
  "provisioning",
  "active",
  "suspended",
  "deleting",
  "deleted",
]);

export const TenantSchema = z.object({
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

export const ApiKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateTenantRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  plan: z.string().min(1).optional(),
  limits: LimitsSchema.optional(),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

/** The key's secret is returned once, here, and never again. */
export const CreateTenantResponseSchema = z.object({
  tenant: TenantSchema,
  apiKey: ApiKeySchema,
  secret: z.string(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponseSchema>;

export const CreateKeyRequestSchema = z.object({ label: z.string().max(100).optional() });
export type CreateKeyRequest = z.infer<typeof CreateKeyRequestSchema>;

export const CreateKeyResponseSchema = z.object({ apiKey: ApiKeySchema, secret: z.string() });
export type CreateKeyResponse = z.infer<typeof CreateKeyResponseSchema>;

export const ListKeysResponseSchema = z.object({ keys: z.array(ApiKeySchema) });
export type ListKeysResponse = z.infer<typeof ListKeysResponseSchema>;

export const ListTenantsResponseSchema = z.object({ tenants: z.array(TenantSchema) });
export type ListTenantsResponse = z.infer<typeof ListTenantsResponseSchema>;

export const ExportResponseSchema = z.object({
  /** A `pg_dump` custom-format file of the tenant's database, in the control service's export directory. */
  dumpFile: z.string(),
  /** The tenant's object keys and sizes, as JSON, next to the dump. */
  objectsFile: z.string(),
  objectPrefix: z.string(),
  objectCount: z.number().int().nonnegative(),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;
