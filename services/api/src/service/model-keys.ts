// A tenant's own model keys. The key goes in sealed (the api holds only the public key) and never comes back out.
import type { ListModelKeysResponse } from "@kerby/contracts";
import { audit, deleteModelKey, listModelKeys, putModelKey } from "@kerby/control-plane";
import type { ApiDeps, Principal } from "../types/index.ts";

export async function setModelKey(
  deps: ApiDeps,
  principal: Principal,
  provider: string,
  apiKey: string,
): Promise<void> {
  await putModelKey(deps.control, deps.sealer, principal.tenantId, provider, apiKey);
  await audit(deps.control, {
    tenantId: principal.tenantId,
    actor: principal.actor,
    action: "model_key.set",
    detail: { provider },
  });
}

export async function removeModelKey(
  deps: ApiDeps,
  principal: Principal,
  provider: string,
): Promise<boolean> {
  const removed = await deleteModelKey(deps.control, principal.tenantId, provider);
  if (removed) {
    await audit(deps.control, {
      tenantId: principal.tenantId,
      actor: principal.actor,
      action: "model_key.delete",
      detail: { provider },
    });
  }
  return removed;
}

export async function listTenantModelKeys(
  deps: ApiDeps,
  principal: Principal,
): Promise<ListModelKeysResponse> {
  const keys = await listModelKeys(deps.control, principal.tenantId);
  return {
    keys: keys.map((k) => ({ provider: k.provider, createdAt: k.createdAt.toISOString() })),
  };
}
