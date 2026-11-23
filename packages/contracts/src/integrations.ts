// Integrations (ADR 0019): a tenant's named clients. Every API key belongs to one, and what a key may do is its
// integration's: `admin` everything, `restricted` conversations and judgments with only the tools it was granted.
import { z } from "zod";

export const IntegrationRoleSchema = z.enum(["admin", "restricted"]);
export type IntegrationRole = z.infer<typeof IntegrationRoleSchema>;

/** Unique among a tenant's live integrations. */
export const IntegrationNameSchema = z.string().trim().min(1).max(100);

/** The integration every tenant starts with, holding its first key (and, after the migration, every older key). */
export const DEFAULT_INTEGRATION_NAME = "default";

const IntegrationSchema = z.object({
  id: z.uuid(),
  name: IntegrationNameSchema,
  role: IntegrationRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

/** `GET /v1/integrations`: the tenant's live integrations, so an admin can name one when it grants tools. */
export const ListIntegrationsResponseSchema = z.object({
  integrations: z.array(IntegrationSchema),
});
export type ListIntegrationsResponse = z.infer<typeof ListIntegrationsResponseSchema>;
