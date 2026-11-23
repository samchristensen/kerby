// What a signed-in person does to their tenant: model keys and the overview (integrations and their API keys are in
// integrations.ts). Each call is scoped to the session's tenant, and each change is audited as `user:<id>`, never with a
// key's value.
import { PutModelKeyRequestSchema } from "@kerby/contracts";
import {
  audit,
  deleteModelKey,
  getTenant,
  listApiKeys,
  listModelKeys,
  ModelKeyLimitError,
  putModelKey,
} from "@kerby/control-plane";
import type {
  ConsoleDeps,
  FormFailure,
  FormInput,
  Overview,
  ProviderView,
  Session,
} from "../types/index.ts";
import { parseForm, refuse } from "./forms.ts";

const actor = (session: Session) => `user:${session.userId}`;

export function createWorkspace(deps: ConsoleDeps) {
  const { control, sealer, settings } = deps;
  /** Every provider a tenant may store a key for: chat models and judgments. One of both kinds (OpenCode) is listed once. */
  const keyProviders = [...new Set([...settings.modelProviders, ...settings.judgmentProviders])];

  return {
    async overview(session: Session): Promise<Overview> {
      const tenant = await getTenant(control, session.tenantId);
      if (!tenant) throw new Error(`tenant ${session.tenantId} of a live session has no row`);
      const [keys, modelKeys] = await Promise.all([
        listApiKeys(control, session.tenantId),
        listModelKeys(control, session.tenantId),
      ]);
      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        status: tenant.status,
        plan: tenant.plan,
        createdAt: tenant.createdAt.toISOString(),
        limits: tenant.limits,
        activeApiKeys: keys.filter((key) => !key.revokedAt).length,
        modelKeys: modelKeys.length,
        apiUrl: settings.apiPublicUrl,
      };
    },

    async providers(session: Session): Promise<ProviderView[]> {
      const stored = new Map(
        (await listModelKeys(control, session.tenantId)).map((k) => [k.provider, k.createdAt]),
      );
      return keyProviders.map((id) => ({
        id,
        configured: stored.has(id),
        chat: settings.modelProviders.includes(id),
        decisions: settings.judgmentProviders.includes(id),
        updatedAt: stored.get(id)?.toISOString() ?? null,
      }));
    },

    async setModelKey(
      session: Session,
      provider: string,
      form: FormInput,
    ): Promise<{ ok: true } | FormFailure> {
      // The adapters' lists (ADR 0008, 0015): a key for a provider nothing can use would fail only at the first call.
      if (!keyProviders.includes(provider)) return refuse("Unknown model provider.");
      // A pasted key often carries a newline.
      const apiKey = typeof form.apiKey === "string" ? form.apiKey.trim() : form.apiKey;
      const parsed = parseForm(PutModelKeyRequestSchema, { apiKey });
      if (!parsed.ok) return parsed;
      try {
        await putModelKey(control, sealer, session.tenantId, provider, parsed.data.apiKey);
      } catch (error) {
        if (error instanceof ModelKeyLimitError) return refuse(error.message);
        throw error;
      }
      await audit(control, {
        tenantId: session.tenantId,
        actor: actor(session),
        action: "model_key.set",
        detail: { provider },
      });
      return { ok: true };
    },

    async removeModelKey(session: Session, provider: string): Promise<boolean> {
      if (!keyProviders.includes(provider)) return false;
      const removed = await deleteModelKey(control, session.tenantId, provider);
      if (removed) {
        await audit(control, {
          tenantId: session.tenantId,
          actor: actor(session),
          action: "model_key.delete",
          detail: { provider },
        });
      }
      return removed;
    },
  };
}
