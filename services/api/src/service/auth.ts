import { createHash } from "node:crypto";
import { SCOPES, type Scope, type Visibility } from "@kerby/contracts";
import {
  authenticateApiKey,
  authenticateConsoleSession,
  type TenantRecord,
} from "@kerby/control-plane";
import type { ControlDb } from "@kerby/db";
import { type Principal, TenantUnavailableError, UnauthorizedError } from "../types/index.ts";

/** Who a credential acts as, apart from its tenant, whose status is checked on every use. */
type Identity = Omit<Principal, "tenantId" | "limits">;

type Entry = { tenant: TenantRecord; identity: Identity; expiresAt: number };
type Found = { tenant: TenantRecord; identity: Identity } | undefined;

/**
 * What a control-plane lookup goes through before it runs (the caller's failed-authentication limit): it may wait its
 * turn, and may refuse by throwing instead of calling `lookup`.
 */
type LookupGate = (lookup: () => Promise<Found>) => Promise<Found>;

export interface Authenticator {
  /**
   * Resolve a presented credential: an API key, or a console session token. Only a lookup the cache cannot answer, and
   * that no other request has in flight for the same credential, goes through `gate`. Throws `UnauthorizedError`,
   * `TenantUnavailableError`, or what `gate` throws.
   */
  authenticate(presented: string, gate?: LookupGate): Promise<Principal>;
}

/** A person in the console acts as the tenant: every scope, everything visible, attributed to no integration (ADR 0020). */
const CONSOLE_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

/**
 * Who a verified API key or console session is. `actor` is for the audit log: `key:<id>` or `user:<id>`. A key acts for
 * its integration with that integration's scopes, and sees only its own work unless it holds `tenant`.
 */
async function resolve(control: ControlDb, presented: string): Promise<Found> {
  if (presented.startsWith("kb_")) {
    const found = await authenticateApiKey(control, presented);
    if (!found) return undefined;
    const scopes: ReadonlySet<Scope> = new Set(found.integration.scopes);
    const visibility: Visibility = scopes.has("tenant")
      ? "tenant"
      : { integrationId: found.integration.id };
    return {
      tenant: found.tenant,
      identity: {
        actor: `key:${found.keyId}`,
        integrationId: found.integration.id,
        scopes,
        visibility,
      },
    };
  }
  // The console forwards the signed-in person's session token (ADR 0014): the tenant is the session's, never the caller's.
  const found = await authenticateConsoleSession(control, presented);
  return (
    found && {
      tenant: found.tenant,
      identity: {
        actor: `user:${found.userId}`,
        integrationId: null,
        scopes: CONSOLE_SCOPES,
        visibility: "tenant",
      },
    }
  );
}

/**
 * Credentials the cache keeps at most: past it the least recently used is forgotten and looked up again when next
 * presented. Each entry is a tenant row (well under 1 KB), so the bound is a few MB however many keys and console
 * sessions a process sees.
 */
const MAX_CACHED_CREDENTIALS = 10_000;

/**
 * Verifies credentials against the control plane and trusts a verified one for `ttlMs`. Suspension, revocation, sign-out,
 * deletion and a change of an integration's scopes therefore take effect within one TTL (ADR 0004, 0020). Failures are
 * never cached: a wrong key costs a lookup. The cache is least recently used first, bounded by `maxEntries`. Concurrent
 * requests with one credential share one lookup, so a client that opens many requests at once with a key the cache does
 * not hold yet costs one lookup and one admission, not one each.
 */
export function createAuthenticator(
  control: ControlDb,
  ttlMs: number,
  options: { now?: () => number; maxEntries?: number } = {},
): Authenticator {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_CACHED_CREDENTIALS;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Entry>>();
  /** The live entry for `cacheKey`, now the most recently used; an expired one is dropped. */
  function hit(cacheKey: string): Entry | undefined {
    const entry = cache.get(cacheKey);
    if (!entry) return undefined;
    cache.delete(cacheKey);
    if (entry.expiresAt <= now()) return undefined;
    cache.set(cacheKey, entry);
    return entry;
  }

  function remember(cacheKey: string, entry: Entry): void {
    cache.set(cacheKey, entry);
    // Least recently used first: drop expired entries from the front, then whatever is past the bound.
    for (const [key, oldest] of cache) {
      if (cache.size <= maxEntries && oldest.expiresAt > now()) break;
      cache.delete(key);
    }
  }

  function lookUp(cacheKey: string, presented: string, gate?: LookupGate): Promise<Entry> {
    const lookup = (async () => {
      try {
        const run = () => resolve(control, presented);
        const found = await (gate ? gate(run) : run());
        if (!found) throw new UnauthorizedError("invalid API key");
        const entry = { tenant: found.tenant, identity: found.identity, expiresAt: now() + ttlMs };
        if (ttlMs > 0) remember(cacheKey, entry);
        return entry;
      } finally {
        inFlight.delete(cacheKey);
      }
    })();
    inFlight.set(cacheKey, lookup);
    return lookup;
  }

  return {
    async authenticate(presented, gate) {
      // Keyed by a hash so raw keys are not kept in memory longer than the request.
      const cacheKey = createHash("sha256").update(presented).digest("hex");
      const entry =
        hit(cacheKey) ?? (await (inFlight.get(cacheKey) ?? lookUp(cacheKey, presented, gate)));
      if (entry.tenant.status !== "active") {
        throw new TenantUnavailableError(`tenant is ${entry.tenant.status}`);
      }
      return { tenantId: entry.tenant.id, ...entry.identity, limits: entry.tenant.limits };
    },
  };
}
