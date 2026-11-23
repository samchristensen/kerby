import type { Blobs } from "@kerby/blobs";
import type { Limits, Scope, Visibility } from "@kerby/contracts";
import type { ControlDb, TenantPools } from "@kerby/db";
import type { Destinations } from "@kerby/delivery";
import type { Sealer } from "@kerby/secrets";

export type ApiDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  /** Seals tenants' model keys to the platform public key; it cannot open them. */
  sealer: Sealer;
  /** Seals subscriptions' signing secrets to the dispatcher's public key (ADR 0019); only the dispatcher opens them. */
  deliverySealer: Sealer;
  /** One adapter per destination kind: the api makes secrets and checks configs with them, never delivers. */
  destinations: Destinations;
  settings: {
    /** The model a conversation gets when the request names none; without one, a request must name its model. */
    defaultModel: string | undefined;
    /** Providers whose models run conversations, and so may hold a key: the harness adapter's list, injected by the composition root. */
    modelProviders: readonly string[];
    /** Providers that embed text for chat search (ADR 0021), and so may hold a key: the embeddings adapter's list, injected likewise. */
    embeddingProviders: readonly string[];
    /** How long `POST /v1/search` waits for a worker to embed the query before answering with keyword matches. */
    searchWaitMs: number;
    /** Providers that run judgments (ADR 0015), and so may hold a key: the judgment adapters' lists, injected likewise. */
    judgmentProviders: readonly string[];
    /** Providers whose runs need no tenant key (the development fake model). Empty in production. */
    keylessProviders: readonly string[];
    defaultSystem: string;
    authCacheMs: number;
    /** Open event streams one tenant may hold on one api process; each leases the tenant's pool. */
    maxStreamsPerTenant: number;
    /** Open event streams this api process holds in all; past it a new stream is a 503 (docs/deploy.md#postgres). */
    maxStreamsPerProcess: number;
    /** How often an open event stream confirms its key and tenant are still allowed. */
    streamRecheckMs: number;
    /** Requests per minute for a tenant whose limits do not set `requestsPerMinute`; counted per api process. */
    defaultRequestsPerMinute: number;
    /** Stored bytes for a tenant whose limits do not set `storageBytes`. */
    defaultStorageBytes: number;
    /** Failed authentications one client address may make per minute before it is refused without a lookup. */
    failedAuthPerMinute: number;
    /** Take the client address from the left-most `X-Forwarded-For` entry (behind Railway's proxy) instead of the socket. */
    trustProxy: boolean;
    /** Event subscriptions a tenant may hold when its limits do not set `subscriptions`. */
    defaultSubscriptions: number;
  };
};

/**
 * Who is calling: established from a verified API key or console session, never from a request body. `actor` is
 * `key:<id>` or `user:<id>`. A key acts for its integration, with its scopes; a console session acts as the tenant, with
 * every scope and no integration (ADR 0020).
 */
export type Principal = {
  tenantId: string;
  actor: string;
  integrationId: string | null;
  scopes: ReadonlySet<Scope>;
  /** Whose work it sees: `"tenant"` with the `tenant` scope, else only its integration's. */
  visibility: Visibility;
  limits: Limits;
};

/** No valid key. */
export class UnauthorizedError extends Error {
  override name = "UnauthorizedError";
}

/** A valid key for a tenant that may not use the API now (suspended, deleted, still provisioning). */
export class TenantUnavailableError extends Error {
  override name = "TenantUnavailableError";
}

/** The caller's address has failed authentication too often: refused before any lookup. */
export class LookupRefusedError extends Error {
  override name = "LookupRefusedError";
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`too many failed authentications; retry in ${retryAfterSeconds} s`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}
