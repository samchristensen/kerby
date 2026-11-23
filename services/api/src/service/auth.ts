import { createHash } from "node:crypto";
import {
  authenticateApiKey,
  authenticateConsoleSession,
  type TenantRecord,
} from "@kerby/control-plane";
import type { ControlDb } from "@kerby/db";
import { type Principal, TenantUnavailableError, UnauthorizedError } from "../types/index.ts";

type Entry = { tenant: TenantRecord; actor: string; expiresAt: number };

export interface Authenticator {
  /** Resolve a presented credential: an API key, or a console session token. Throws `UnauthorizedError` or `TenantUnavailableError`. */
  authenticate(presented: string): Promise<Principal>;
}

/** Who a verified API key or console session is, for the audit log: `key:<id>` or `user:<id>`. */
async function resolve(
  control: ControlDb,
  presented: string,
): Promise<{ tenant: TenantRecord; actor: string } | undefined> {
  if (presented.startsWith("kb_")) {
    const found = await authenticateApiKey(control, presented);
    return found && { tenant: found.tenant, actor: `key:${found.keyId}` };
  }
  // The console forwards the signed-in person's session token (ADR 0014): the tenant is the session's, never the caller's.
  const found = await authenticateConsoleSession(control, presented);
  return found && { tenant: found.tenant, actor: `user:${found.userId}` };
}

/**
 * Verifies credentials against the control plane and trusts a verified one for `ttlMs`. Suspension, revocation, sign-out
 * and deletion therefore take effect within one TTL (ADR 0004). Failures are never cached: a wrong key costs a lookup.
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
        const found = await resolve(control, presented);
        if (!found) throw new UnauthorizedError("invalid API key");
        entry = { tenant: found.tenant, actor: found.actor, expiresAt: now() + ttlMs };
        if (ttlMs > 0) cache.set(cacheKey, entry);
      }
      if (entry.tenant.status !== "active") {
        throw new TenantUnavailableError(`tenant is ${entry.tenant.status}`);
      }
      return { tenantId: entry.tenant.id, actor: entry.actor, limits: entry.tenant.limits };
    },
  };
}
