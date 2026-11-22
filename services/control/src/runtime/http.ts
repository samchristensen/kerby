// The operator API: tenant lifecycle and keys, behind one bearer token. Never exposed to tenants.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ApiKey,
  type BackupResponse,
  CreateKeyRequestSchema,
  type CreateKeyResponse,
  CreateTenantRequestSchema,
  type CreateTenantResponse,
  type ExportResponse,
  LimitsSchema,
  type ListKeysResponse,
  type ListTenantsResponse,
  RestoreRequestSchema,
  type RestoreResponse,
  type Tenant,
} from "@kerby/contracts";
import type { ApiKeyRecord, TenantRecord } from "@kerby/control-plane";
import {
  bearerToken,
  createRouter,
  type FetchHandler,
  HttpError,
  json,
  type Route,
  readJson,
} from "@kerby/serve";
import { backupBuckets, restoreFromBackup } from "../service/backup.ts";
import { exportTenant } from "../service/export.ts";
import { createKey, listKeys, revokeKey, rotateKey } from "../service/keys.ts";
import { migrateAllTenants } from "../service/migrate.ts";
import {
  deleteTenant,
  getTenantRecord,
  listTenantRecords,
  provisionTenant,
  resumeTenant,
  suspendTenant,
} from "../service/tenants.ts";
import { ConflictError, type ControlDeps, NotFoundError } from "../types/index.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

function tenantResource(tenant: TenantRecord): Tenant {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    limits: LimitsSchema.parse(tenant.limits),
    region: tenant.region,
    schemaVersion: tenant.schemaVersion,
    createdAt: tenant.createdAt.toISOString(),
  };
}

function keyResource(key: ApiKeyRecord): ApiKey {
  return {
    id: key.id,
    label: key.label,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/** Service errors are the service layer's; HTTP statuses are decided here. */
function mapErrors(handler: Route[2]): Route[2] {
  return async (request, params) => {
    try {
      return await handler(request, params);
    } catch (error) {
      if (error instanceof NotFoundError) throw new HttpError(404, "not_found", error.message);
      if (error instanceof ConflictError) throw new HttpError(409, "conflict", error.message);
      throw error;
    }
  };
}

export function createControlApp(deps: ControlDeps, operatorToken: string): FetchHandler {
  const expected = digest(operatorToken);
  const authorized = (handler: Route[2]): Route[2] =>
    mapErrors(async (request, params) => {
      const presented = bearerToken(request);
      // Compare digests so length and content do not leak through timing.
      if (!presented || !timingSafeEqual(digest(presented), expected)) {
        throw new HttpError(401, "unauthorized", "a valid operator token is required");
      }
      return handler(request, params);
    });

  const id = (params: Record<string, string>) => params.id ?? "";
  const routes: Route[] = [
    ["GET", "/healthz", () => json(200, { ok: true })],
    [
      "POST",
      "/v1/operator/tenants",
      authorized(async (request) => {
        const body = await readJson(request, CreateTenantRequestSchema);
        const { tenant, key } = await provisionTenant(deps, body);
        const response: CreateTenantResponse = {
          tenant: tenantResource(tenant),
          apiKey: keyResource(key.key),
          secret: key.secret,
        };
        return json(201, response);
      }),
    ],
    [
      "GET",
      "/v1/operator/tenants",
      authorized(async () => {
        const response: ListTenantsResponse = {
          tenants: (await listTenantRecords(deps)).map(tenantResource),
        };
        return json(200, response);
      }),
    ],
    [
      "GET",
      "/v1/operator/tenants/:id",
      authorized(async (_request, params) =>
        json(200, tenantResource(await getTenantRecord(deps, id(params)))),
      ),
    ],
    [
      "POST",
      "/v1/operator/tenants/:id/suspend",
      authorized(async (_request, params) =>
        json(200, tenantResource(await suspendTenant(deps, id(params)))),
      ),
    ],
    [
      "POST",
      "/v1/operator/tenants/:id/resume",
      authorized(async (_request, params) =>
        json(200, tenantResource(await resumeTenant(deps, id(params)))),
      ),
    ],
    [
      "DELETE",
      "/v1/operator/tenants/:id",
      authorized(async (_request, params) => {
        await deleteTenant(deps, id(params));
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "POST",
      "/v1/operator/tenants/:id/export",
      authorized(async (_request, params) => {
        const exported = await exportTenant(deps, id(params));
        const response: ExportResponse = exported;
        return json(200, response);
      }),
    ],
    [
      "GET",
      "/v1/operator/tenants/:id/keys",
      authorized(async (_request, params) => {
        const response: ListKeysResponse = {
          keys: (await listKeys(deps, id(params))).map(keyResource),
        };
        return json(200, response);
      }),
    ],
    [
      "POST",
      "/v1/operator/tenants/:id/keys",
      authorized(async (request, params) => {
        const body = await readJson(request, CreateKeyRequestSchema);
        const created = await createKey(deps, id(params), body.label);
        const response: CreateKeyResponse = {
          apiKey: keyResource(created.key),
          secret: created.secret,
        };
        return json(201, response);
      }),
    ],
    [
      "POST",
      "/v1/operator/tenants/:id/keys/:keyId/rotate",
      authorized(async (_request, params) => {
        const created = await rotateKey(deps, id(params), params.keyId ?? "");
        const response: CreateKeyResponse = {
          apiKey: keyResource(created.key),
          secret: created.secret,
        };
        return json(201, response);
      }),
    ],
    [
      "DELETE",
      "/v1/operator/tenants/:id/keys/:keyId",
      authorized(async (_request, params) => {
        await revokeKey(deps, id(params), params.keyId ?? "");
        return new Response(null, { status: 204 });
      }),
    ],
    [
      "POST",
      "/v1/operator/migrate",
      authorized(async () => json(200, await migrateAllTenants(deps))),
    ],
    [
      "POST",
      "/v1/operator/backup",
      authorized(async () => {
        const response: BackupResponse = await backupBuckets(deps);
        return json(200, response);
      }),
    ],
    [
      "POST",
      "/v1/operator/backup/restore",
      authorized(async (request) => {
        const body = await readJson(request, RestoreRequestSchema);
        const response: RestoreResponse = await restoreFromBackup(deps, body.tenantId);
        return json(200, response);
      }),
    ],
  ];
  return createRouter(routes);
}
