// Integrations (ADR 0020): a named principal of a tenant that owns API keys, scopes and event subscriptions.
import { z } from "zod";

/** What an integration's keys may do. Every api route declares the one it needs. */
export const SCOPES = ["conversations", "judgments", "events", "tenant", "admin"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

/** One line per scope, for the console's form and the docs. */
export const SCOPE_DESCRIPTIONS: Readonly<Record<Scope, string>> = {
  conversations: "Create conversations, post messages, read them, stream their events and traces.",
  judgments: "Submit judgments and read their answers.",
  events: "Read the event log: GET /v1/events.",
  tenant:
    "See everything in the workspace: conversations, judgments and events started by any integration or in the console, not only its own.",
  admin: "Manage model keys, prompts and event subscriptions.",
};

export const IntegrationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, "letters, digits, spaces, dots, dashes, underscores");

/** Every tenant has one from provisioning, with every scope; the keys made before integrations belong to it. */
export const DEFAULT_INTEGRATION = "default";

/**
 * Whose work a caller sees (ADR 0020): everything in the tenant, or only what one integration started. Repo functions
 * that read conversations, judgments or events take one, so no query can forget the filter.
 */
export type Visibility = "tenant" | { integrationId: string };

/**
 * `GET /v1/integrations` (`admin`): the tenant's live integrations, so an admin can name one when it grants tools
 * (ADR 0022). Read only: integrations and their keys are made in the console (ADR 0020).
 */
export const ListIntegrationsResponseSchema = z.object({
  integrations: z.array(
    z.object({
      id: z.uuid(),
      name: IntegrationNameSchema,
      scopes: z.array(ScopeSchema),
      createdAt: z.iso.datetime(),
    }),
  ),
});
export type ListIntegrationsResponse = z.infer<typeof ListIntegrationsResponseSchema>;
