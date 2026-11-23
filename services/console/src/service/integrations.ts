// A tenant's integrations and their API keys (ADR 0019), managed by a signed-in person. Each call is scoped to the
// session's tenant: an integration or key id of another tenant is not found. Each change is audited as `user:<id>`, never
// with a key's value.
import { IntegrationRoleSchema } from "@kerby/contracts";
import {
  type ApiKeyRecord,
  archiveIntegration,
  audit,
  createApiKey,
  createIntegration,
  getIntegration,
  IntegrationNameTakenError,
  IntegrationNotFoundError,
  type IntegrationRecord,
  listApiKeys,
  listIntegrations,
  revokeApiKey,
  updateIntegration,
} from "@kerby/control-plane";
import { z } from "zod";
import type {
  ApiKeyView,
  ConsoleDeps,
  ConsoleService,
  IntegrationView,
  Session,
} from "../types/index.ts";
import { parseForm, refuse } from "./forms.ts";

const actor = (session: Session) => `user:${session.userId}`;

function keyView(key: ApiKeyRecord): ApiKeyView {
  return {
    id: key.id,
    integrationId: key.integrationId,
    label: key.label,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

function integrationView(integration: IntegrationRecord, keys: ApiKeyRecord[]): IntegrationView {
  return {
    id: integration.id,
    name: integration.name,
    role: integration.role,
    createdAt: integration.createdAt.toISOString(),
    updatedAt: integration.updatedAt.toISOString(),
    liveKeys: keys.filter((key) => key.integrationId === integration.id && !key.revokedAt).length,
  };
}

const IntegrationFormSchema = z.object({
  name: z
    .string("a name is required")
    .trim()
    .min(1, "a name is required")
    .max(100, "at most 100 characters"),
  role: z.enum(IntegrationRoleSchema.options, "choose admin or restricted"),
});
const KeyForm = z.object({
  label: z.string().trim().max(100, "at most 100 characters").default(""),
});

type IntegrationOps = Pick<
  ConsoleService,
  | "integrations"
  | "integration"
  | "createIntegration"
  | "updateIntegration"
  | "archiveIntegration"
  | "createApiKey"
  | "revokeApiKey"
>;

export function createIntegrations(deps: ConsoleDeps): IntegrationOps {
  const { control } = deps;
  const taken = (error: unknown) => {
    if (error instanceof IntegrationNameTakenError)
      return { ok: false as const, fields: { name: "Another integration has this name" } };
    throw error;
  };

  return {
    async integrations(session) {
      const [integrations, keys] = await Promise.all([
        listIntegrations(control, session.tenantId),
        listApiKeys(control, session.tenantId),
      ]);
      return integrations.map((integration) => integrationView(integration, keys));
    },

    async integration(session, id) {
      const integration = await getIntegration(control, session.tenantId, id);
      if (!integration) return undefined;
      const keys = (await listApiKeys(control, session.tenantId)).filter(
        (key) => key.integrationId === integration.id,
      );
      return { ...integrationView(integration, keys), keys: keys.map(keyView).reverse() };
    },

    async createIntegration(session, form) {
      const parsed = parseForm(IntegrationFormSchema, form);
      if (!parsed.ok) return parsed;
      let integration: IntegrationRecord;
      try {
        integration = await createIntegration(control, {
          tenantId: session.tenantId,
          ...parsed.data,
        });
      } catch (error) {
        return taken(error);
      }
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "integration.create",
        detail: { integrationId: integration.id, role: integration.role },
      });
      return { ok: true, integration: integrationView(integration, []) };
    },

    async updateIntegration(session, id, form) {
      const parsed = parseForm(IntegrationFormSchema, form);
      if (!parsed.ok) return parsed;
      let integration: IntegrationRecord | undefined;
      try {
        integration = await updateIntegration(control, session.tenantId, id, parsed.data);
      } catch (error) {
        return taken(error);
      }
      if (!integration) return refuse("This integration no longer exists.");
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "integration.update",
        detail: { integrationId: integration.id, role: integration.role },
      });
      const keys = await listApiKeys(control, session.tenantId);
      return { ok: true, integration: integrationView(integration, keys) };
    },

    async archiveIntegration(session, id) {
      const archived = await archiveIntegration(control, session.tenantId, id);
      if (archived) {
        await audit(control, {
          tenantId: session.tenantId,
          actor: actor(session),
          action: "integration.archive",
          detail: { integrationId: id },
        });
      }
      return archived;
    },

    async createApiKey(session, integrationId, form) {
      const parsed = parseForm(KeyForm, form);
      if (!parsed.ok) return parsed;
      let created: Awaited<ReturnType<typeof createApiKey>>;
      try {
        created = await createApiKey(control, session.tenantId, integrationId, parsed.data.label);
      } catch (error) {
        if (error instanceof IntegrationNotFoundError)
          return refuse("This integration no longer exists.");
        throw error;
      }
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "key.create",
        detail: { keyId: created.key.id, integrationId: created.key.integrationId },
      });
      return { ok: true, key: keyView(created.key), secret: created.secret };
    },

    async revokeApiKey(session, keyId) {
      const key = (await listApiKeys(control, session.tenantId)).find((k) => k.id === keyId);
      if (!key || !(await revokeApiKey(control, session.tenantId, keyId))) return false;
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "key.revoke",
        detail: { keyId, integrationId: key.integrationId },
      });
      return true;
    },
  };
}
