// A tenant's integrations, for the operator (ADR 0019). The console manages them for the tenant's people; the operator
// lists them and adds one, e.g. to issue a restricted key from a script.

import { DEFAULT_INTEGRATION_NAME, type IntegrationRole } from "@kerby/contracts";
import {
  audit,
  createIntegration,
  findIntegrationByName,
  getIntegration,
  IntegrationNameTakenError,
  type IntegrationRecord,
  listIntegrations,
} from "@kerby/control-plane";
import type { ControlQueryable } from "@kerby/db";
import { ConflictError, type ControlDeps, NotFoundError } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

export async function listOperatorIntegrations(
  deps: ControlDeps,
  tenantId: string,
): Promise<IntegrationRecord[]> {
  await getTenantRecord(deps, tenantId);
  return listIntegrations(deps.control, tenantId);
}

export async function createOperatorIntegration(
  deps: ControlDeps,
  tenantId: string,
  input: { name: string; role: IntegrationRole },
): Promise<IntegrationRecord> {
  await getTenantRecord(deps, tenantId);
  try {
    const integration = await createIntegration(deps.control, { tenantId, ...input });
    await audit(deps.control, {
      tenantId,
      actor: "operator",
      action: "integration.create",
      detail: { integrationId: integration.id, role: integration.role },
    });
    return integration;
  } catch (error) {
    if (error instanceof IntegrationNameTakenError)
      throw new ConflictError(error.message, "name_taken");
    throw error;
  }
}

/** The live integration a new key goes into: the one named, or the tenant's `default`. */
export async function keyIntegration(
  db: ControlQueryable,
  tenantId: string,
  integrationId: string | undefined,
): Promise<IntegrationRecord> {
  const found =
    integrationId === undefined
      ? await findIntegrationByName(db, tenantId, DEFAULT_INTEGRATION_NAME)
      : await getIntegration(db, tenantId, integrationId);
  if (!found)
    throw new NotFoundError(
      integrationId === undefined
        ? `tenant ${tenantId} has no live "${DEFAULT_INTEGRATION_NAME}" integration. Fix: pass integrationId, one of GET /v1/operator/tenants/${tenantId}/integrations`
        : `integration ${integrationId} is not a live integration of tenant ${tenantId}. Fix: pass one of GET /v1/operator/tenants/${tenantId}/integrations`,
    );
  return found;
}
