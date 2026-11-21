import {
  type ApiKeyRecord,
  audit,
  type CreatedKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@kerby/control-plane";
import { type ControlDeps, NotFoundError } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

const ACTOR = "operator";

export async function createKey(
  deps: ControlDeps,
  tenantId: string,
  label?: string,
): Promise<CreatedKey> {
  await getTenantRecord(deps, tenantId);
  const created = await createApiKey(deps.control, tenantId, label);
  await audit(deps.control, {
    tenantId,
    actor: ACTOR,
    action: "key.create",
    detail: { keyId: created.key.id },
  });
  return created;
}

export async function listKeys(deps: ControlDeps, tenantId: string): Promise<ApiKeyRecord[]> {
  await getTenantRecord(deps, tenantId);
  return listApiKeys(deps.control, tenantId);
}

/** A new key, and the old one revoked in the same transaction: there is never a moment with neither. */
export async function rotateKey(
  deps: ControlDeps,
  tenantId: string,
  keyId: string,
): Promise<CreatedKey> {
  await getTenantRecord(deps, tenantId);
  const created = await deps.control.transaction(async (tx) => {
    if (!(await revokeApiKey(tx, tenantId, keyId)))
      throw new NotFoundError(`key ${keyId} not found`);
    return createApiKey(tx, tenantId, "rotated");
  });
  await audit(deps.control, {
    tenantId,
    actor: ACTOR,
    action: "key.rotate",
    detail: { revokedKeyId: keyId, newKeyId: created.key.id },
  });
  return created;
}

export async function revokeKey(deps: ControlDeps, tenantId: string, keyId: string): Promise<void> {
  await getTenantRecord(deps, tenantId);
  if (!(await revokeApiKey(deps.control, tenantId, keyId)))
    throw new NotFoundError(`key ${keyId} not found`);
  await audit(deps.control, { tenantId, actor: ACTOR, action: "key.revoke", detail: { keyId } });
}
