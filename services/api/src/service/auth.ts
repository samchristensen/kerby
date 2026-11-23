import { createHash } from "node:crypto";
import {
  authenticateApiKey,
  authenticateConsoleSession,
  type TenantRecord,
} from "@kerby/control-plane";
import type { ControlDb } from "@kerby/db";
import { type Principal, TenantUnavailableError, UnauthorizedError } from "../types/index.ts";

type Entry = { tenant: TenantRecord; actor: string; expiresAt: number };
type Found = { tenant: TenantRecord; actor: string } | undefined;

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

/** Who a verified API key or console session is, for the audit log: `key:<id>` or `user:<id>`. */
async function resolve(control: ControlDb, presented: string): Promise<Found> {
  if (presented.startsWith("kb_")) {
    const found = await authenticateApiKey(control, presented);
    return found && { tenant: found.tenant, actor: `key:${found.keyId}` };
  }
  // The console forwards the signed-in person's session token (ADR 0014): the tenant is the session's, never the caller's.
  const found = await authenticateConsoleSession(control, presented);
  return found && { tenant: found.tenant, actor: `user:${found.userId}` };
}

/**
 * Credentials the cache keeps at most: past it the least recently used is forgotten and looked up again when next
 * presented. Each entry is a tenant row (well under 1 KB), so the bound is a few MB however many keys and console
 * sessions a process sees.
 */
const MAX_CACHED_CREDENTIALS = 10_000;

/**
 * Verifies credentials against the control plane and trusts a verified one for `ttlMs`. Suspension, revocation, sign-out
 * and deletion therefore take effect within one TTL (ADR 0004). Failures are never cached: a wrong key costs a lookup.
 * The cache is least recently used first, bounded by `maxEntries`. Concurrent requests with one credential share one
 * lookup, so a client that opens many requests at once with a key the cache does not hold yet costs one lookup and
 * one admission, not one each.
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
        const entry = { tenant: found.tenant, actor: found.actor, expiresAt: now() + ttlMs };
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
      return { tenantId: entry.tenant.id, actor: entry.actor, limits: entry.tenant.limits };
    },
  };
}
