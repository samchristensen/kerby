// The operator API: tenant lifecycle and keys, behind one bearer token. Never exposed to tenants. One more route,
// self-serve sign-up, takes the console's token instead, which opens nothing else (ADR 0014).
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ApiKey,
  type BackupResponse,
  ConsoleSignupRequestSchema,
  type ConsoleSignupResponse,
  CreateKeyRequestSchema,
  type CreateKeyResponse,
  CreateTenantRequestSchema,
  type CreateTenantResponse,
  type ExportResponse,
  type ListKeysResponse,
  type ListTenantsResponse,
  ReissueExportRequestSchema,
  type ReissueExportResponse,
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
import { rotateTenantDbPassword } from "../service/db-credentials.ts";
import { exportTenant, reissueExportUrls } from "../service/export.ts";
import { createKey, listKeys, revokeKey, rotateKey } from "../service/keys.ts";
import { migrateAllTenants } from "../service/migrate.ts";
import { signUp } from "../service/signups.ts";
import {
  deleteTenant,
  getTenantRecord,
  listTenantRecords,
  provisionTenant,
  resumeTenant,
  suspendTenant,
} from "../service/tenants.ts";
import {
  ConflictError,
  type ControlDeps,
  NotFoundError,
  SignupsPausedError,
} from "../types/index.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

function tenantResource(tenant: TenantRecord): Tenant {
  return {
    id: tenant.id,
    name: tenant.name,
    status: tenant.status,
    plan: tenant.plan,
    limits: tenant.limits,
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
  return async (request, params, client) => {
    try {
      return await handler(request, params, client);
    } catch (error) {
      if (error instanceof NotFoundError) throw new HttpError(404, "not_found", error.message);
      if (error instanceof ConflictError) throw new HttpError(409, error.code, error.message);
      if (error instanceof SignupsPausedError) {
        return json(
          429,
          { error: { code: "signups_paused", message: error.message } },
          { "retry-after": String(error.retryAfterSeconds) },
        );
      }
      throw error;
    }
  };
}

/** Bearer tokens: the operator's opens every operator route; the console's, when set, opens sign-up only. */
export type ControlTokens = { operator: string; console?: string | undefined };

export function createControlApp(deps: ControlDeps, tokens: ControlTokens): FetchHandler {
  const bearer =
    (expected: Buffer | undefined, what: string) =>
    (handler: Route[2]): Route[2] =>
      mapErrors(async (request, params, client) => {
        const presented = bearerToken(request);
        // Compare digests so length and content do not leak through timing.
        if (!expected || !presented || !timingSafeEqual(digest(presented), expected)) {
          throw new HttpError(401, "unauthorized", `a valid ${what} token is required`);
        }
        return handler(request, params, client);
      });
  const authorized = bearer(digest(tokens.operator), "operator");
  const fromConsole = bearer(tokens.console ? digest(tokens.console) : undefined, "console");

  const id = (params: Record<string, string>) => params.id ?? "";
  const routes: Route[] = [
    ["GET", "/healthz", () => json(200, { ok: true })],
    [
      "POST",
      "/v1/console/signups",
      fromConsole(async (request) => {
        const body = await readJson(request, ConsoleSignupRequestSchema);
        const { tenant, key, userId } = await signUp(deps, body);
        const response: ConsoleSignupResponse = {
          tenantId: tenant.id,
          userId,
          secret: key.secret,
        };
        return json(201, response);
      }),
    ],
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
      // A new random password for the tenant's database role, stored sealed (ADR 0009). Audited; returns no secret.
      "POST",
      "/v1/operator/tenants/:id/rotate-db-password",
      authorized(async (_request, params) =>
        json(200, tenantResource(await rotateTenantDbPassword(deps, id(params)))),
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
      // New URLs for an export that exists, a deleted tenant's too (exports outlive the tenant by the retention).
      "POST",
      "/v1/operator/tenants/:id/export/reissue",
      authorized(async (request, params) => {
        const body = await readJson(request, ReissueExportRequestSchema);
        const response: ReissueExportResponse = await reissueExportUrls(
          deps,
          id(params),
          body.stamp,
        );
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
