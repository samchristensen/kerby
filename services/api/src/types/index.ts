import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";

export type ApiDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  settings: {
    /** Models a conversation may use; the first is the default. */
    models: readonly string[];
    defaultSystem: string;
    authCacheMs: number;
  };
};

/** Who is calling: established from a verified API key, never from a request body. */
export type Principal = { tenantId: string; keyId: string };

/** No valid key. */
export class UnauthorizedError extends Error {
  override name = "UnauthorizedError";
}

/** A valid key for a tenant that may not use the API now (suspended, deleted, still provisioning). */
export class TenantUnavailableError extends Error {
  override name = "TenantUnavailableError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}
