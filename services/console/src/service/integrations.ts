// Integrations (ADR 0020) and their API keys: made, re-scoped and deleted here, in the control database, and audited
// as `user:<id>`, never with a key's value. A key always belongs to one; the api only reads them, so a key cannot mint
// keys. Their subscriptions live behind the api (service/subscriptions.ts); the list here only counts them.
import { IntegrationNameSchema, SCOPE_DESCRIPTIONS, SCOPES, type Scope } from "@kerby/contracts";
import {
  ApiKeyLimitError,
  type ApiKeyRecord,
  audit,
  type CreatedKey,
  createApiKey,
  createIntegration,
  deleteIntegration,
  getIntegration,
  IntegrationNameTakenError,
  type IntegrationRecord,
  listApiKeys,
  listIntegrations,
  MAX_API_KEYS_PER_TENANT,
  revokeApiKey,
  setIntegrationScopes,
} from "@kerby/control-plane";
import { z } from "zod";
import type {
  ApiKeyView,
  ConsoleDeps,
  ConsoleService,
  FormFailure,
  FormInput,
  IntegrationView,
  Session,
} from "../types/index.ts";
import { parseForm, refuse } from "./forms.ts";
import { listAllSubscriptions } from "./subscriptions.ts";

const actor = (session: Session) => `user:${session.userId}`;

/** Form field `scope.<scope>` is the checkbox of `scope`. */
const SCOPE_FIELD_PREFIX = "scope.";

const SCOPE_OPTIONS = SCOPES.map((scope) => ({
  scope,
  description: SCOPE_DESCRIPTIONS[scope],
  field: `${SCOPE_FIELD_PREFIX}${scope}`,
}));

const NameForm = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name the integration")
    .max(64, "at most 64 characters")
    .pipe(IntegrationNameSchema),
});

const LabelForm = z.object({
  label: z.string().trim().max(100, "at most 100 characters").default(""),
});

/** The scopes ticked in a form, in catalog order; none is refused: a key that may do nothing is a mistake. */
function checkedScopes(form: FormInput): { ok: true; scopes: Scope[] } | FormFailure {
  const scopes = SCOPE_OPTIONS.filter(({ field }) => {
    const value = form[field];
    return typeof value === "string" && value !== "";
  }).map(({ scope }) => scope);
  return scopes.length > 0
    ? { ok: true, scopes }
    : { ok: false, fields: { scopes: "Choose at least one scope." } };
}

const integrationView = (integration: IntegrationRecord): IntegrationView => ({
  id: integration.id,
  name: integration.name,
  scopes: integration.scopes,
  createdAt: integration.createdAt.toISOString(),
});

const keyView = (key: ApiKeyRecord): ApiKeyView => ({
  id: key.id,
  label: key.label,
  createdAt: key.createdAt.toISOString(),
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
});

type Integrations = Pick<
  ConsoleService,
  | "scopeOptions"
  | "integrations"
  | "integration"
  | "createIntegration"
  | "setIntegrationScopes"
  | "deleteIntegration"
  | "createApiKey"
  | "revokeApiKey"
>;

export function createIntegrations(deps: ConsoleDeps): Integrations {
  const { control } = deps;

  return {
    scopeOptions: () => SCOPE_OPTIONS,

    async integrations(access) {
      const { tenantId } = access.session;
      const [integrations, keys, subscriptions] = await Promise.all([
        listIntegrations(control, tenantId),
        listApiKeys(control, tenantId),
        listAllSubscriptions(deps, access),
      ]);
      const count = (ids: string[], id: string) => ids.filter((each) => each === id).length;
      const liveKeys = keys.filter((key) => !key.revokedAt).map((key) => key.integrationId);
      const subscribed = subscriptions.map((subscription) => subscription.integrationId);
      return integrations.map((integration) => ({
        ...integrationView(integration),
        activeKeys: count(liveKeys, integration.id),
        subscriptions: count(subscribed, integration.id),
      }));
    },

    async integration(session, id) {
      const integration = await getIntegration(control, session.tenantId, id);
      if (!integration) return undefined;
      const keys = await listApiKeys(control, session.tenantId, integration.id);
      return { ...integrationView(integration), keys: keys.map(keyView).reverse() };
    },

    async createIntegration(session, form) {
      const name = parseForm(NameForm, form);
      const scopes = checkedScopes(form);
      if (!name.ok || !scopes.ok) {
        return {
          ok: false,
          fields: { ...(name.ok ? {} : name.fields), ...(scopes.ok ? {} : scopes.fields) },
        };
      }
      let created: IntegrationRecord;
      try {
        created = await createIntegration(control, session.tenantId, {
          name: name.data.name,
          scopes: scopes.scopes,
        });
      } catch (error) {
        if (error instanceof IntegrationNameTakenError) {
          return {
            ok: false,
            fields: { name: "An integration already has this name. Choose another." },
          };
        }
        throw error;
      }
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "integration.create",
        // An audit detail holds scalars: the scopes as `conversations,events`.
        detail: {
          integrationId: created.id,
          name: created.name,
          scopes: created.scopes.join(","),
        },
      });
      return { ok: true, id: created.id };
    },

    async setIntegrationScopes(session, id, form) {
      const scopes = checkedScopes(form);
      if (!scopes.ok) return scopes;
      const updated = await setIntegrationScopes(control, session.tenantId, id, scopes.scopes);
      if (!updated) return refuse("This integration no longer exists.");
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "integration.scopes",
        detail: { integrationId: id, scopes: updated.scopes.join(",") },
      });
      return { ok: true };
    },

    async deleteIntegration(session, id) {
      const deleted = await deleteIntegration(control, session.tenantId, id);
      if (deleted) {
        await audit(control, {
          tenantId: session.tenantId,
          actor: actor(session),
          action: "integration.delete",
          detail: { integrationId: id },
        });
      }
      return deleted;
    },

    async createApiKey(session, integrationId, form) {
      const parsed = parseForm(LabelForm, form);
      if (!parsed.ok) return parsed;
      if (!(await getIntegration(control, session.tenantId, integrationId))) {
        return refuse("This integration no longer exists.");
      }
      let created: CreatedKey;
      try {
        created = await createApiKey(control, session.tenantId, integrationId, parsed.data.label);
      } catch (error) {
        if (error instanceof ApiKeyLimitError) {
          return refuse(
            `This workspace already has ${MAX_API_KEYS_PER_TENANT} active API keys, the most it may hold. Revoke one you no longer use, then create the new one.`,
          );
        }
        throw error;
      }
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "key.create",
        detail: { keyId: created.key.id, integrationId },
      });
      return { ok: true, key: keyView(created.key), secret: created.secret };
    },

    async revokeApiKey(session, keyId) {
      const revoked = await revokeApiKey(control, session.tenantId, keyId);
      if (revoked) {
        await audit(control, {
          tenantId: session.tenantId,
          actor: actor(session),
          action: "key.revoke",
          detail: { keyId },
        });
      }
      return revoked;
    },
  };
}
