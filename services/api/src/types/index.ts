import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";
import type { Sealer } from "@kerby/secrets";

export type ApiDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  /** Seals tenants' model keys to the platform public key; it cannot open them. */
  sealer: Sealer;
  settings: {
    /** The model a conversation gets when the request names none; without one, a request must name its model. */
    defaultModel: string | undefined;
    /** Providers a tenant may store a key for: the harness adapter's list, injected by the composition root. */
    modelProviders: readonly string[];
    /** Providers whose runs need no tenant key (the development fake model). Empty in production. */
    keylessProviders: readonly string[];
    defaultSystem: string;
    authCacheMs: number;
    /** Open event streams one tenant may hold on one api process; each keeps a database connection. */
    maxStreamsPerTenant: number;
    /** How often an open event stream confirms its key and tenant are still allowed. */
    streamRecheckMs: number;
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
