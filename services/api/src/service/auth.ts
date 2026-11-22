import { createHash } from "node:crypto";
import { authenticateApiKey, type TenantRecord } from "@kerby/control-plane";
import type { ControlDb } from "@kerby/db";
import { type Principal, TenantUnavailableError, UnauthorizedError } from "../types/index.ts";

type Entry = { tenant: TenantRecord; keyId: string; expiresAt: number };

export interface Authenticator {
  /** Resolve a presented key. Throws `UnauthorizedError` or `TenantUnavailableError`. */
  authenticate(presented: string): Promise<Principal>;
}

/**
 * Verifies API keys against the control plane and trusts a verified key for `ttlMs`. Suspension, revocation and
 * deletion therefore take effect within one TTL (ADR 0004). Failures are never cached: a wrong key costs a lookup.
 */
export function createAuthenticator(
  control: ControlDb,
  ttlMs: number,
  now: () => number = Date.now,
): Authenticator {
  const cache = new Map<string, Entry>();
  return {
    async authenticate(presented) {
      // The cache is keyed by a hash so raw keys are not kept in memory longer than the request.
      const cacheKey = createHash("sha256").update(presented).digest("hex");
      let entry = cache.get(cacheKey);
      if (!entry || entry.expiresAt <= now()) {
        cache.delete(cacheKey);
        const found = await authenticateApiKey(control, presented);
        if (!found) throw new UnauthorizedError("invalid API key");
        entry = { tenant: found.tenant, keyId: found.keyId, expiresAt: now() + ttlMs };
        if (ttlMs > 0) cache.set(cacheKey, entry);
      }
      if (entry.tenant.status !== "active") {
        throw new TenantUnavailableError(`tenant is ${entry.tenant.status}`);
      }
      return { tenantId: entry.tenant.id, keyId: entry.keyId, limits: entry.tenant.limits };
    },
  };
}
