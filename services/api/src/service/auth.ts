import { createHash } from "node:crypto";
import type { IntegrationRole } from "@kerby/contracts";
import {
  authenticateApiKey,
  authenticateConsoleSession,
  type TenantRecord,
} from "@kerby/control-plane";
import type { ControlDb } from "@kerby/db";
import { type Principal, TenantUnavailableError, UnauthorizedError } from "../types/index.ts";

type Resolved = {
  tenant: TenantRecord;
  actor: string;
  role: IntegrationRole;
  integrationId: string | null;
};
type Entry = Resolved & { expiresAt: number };

export interface Authenticator {
  /** Resolve a presented credential: an API key, or a console session token. Throws `UnauthorizedError` or `TenantUnavailableError`. */
  authenticate(presented: string): Promise<Principal>;
}

/**
 * Who a verified API key or console session is: the audit actor (`key:<id>` or `user:<id>`) and the role it acts with,
 * its integration's for a key (ADR 0019), `admin` for a console session.
 */
async function resolve(control: ControlDb, presented: string): Promise<Resolved | undefined> {
  if (presented.startsWith("kb_")) {
    const found = await authenticateApiKey(control, presented);
    return (
      found && {
        tenant: found.tenant,
        actor: `key:${found.keyId}`,
        role: found.integration.role,
        integrationId: found.integration.id,
      }
    );
  }
  // The console forwards the signed-in person's session token (ADR 0014): the tenant is the session's, never the caller's.
  const found = await authenticateConsoleSession(control, presented);
  return (
    found && {
      tenant: found.tenant,
      actor: `user:${found.userId}`,
      role: "admin",
      integrationId: null,
    }
  );
}

/**
 * Verifies credentials against the control plane and trusts a verified one for `ttlMs`. Suspension, revocation, sign-out,
 * deletion, a role change and archiving an integration therefore take effect within one TTL (ADR 0004). Failures are never cached: a wrong key costs a lookup.
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
        entry = { ...found, expiresAt: now() + ttlMs };
        if (ttlMs > 0) cache.set(cacheKey, entry);
      }
      if (entry.tenant.status !== "active") {
        throw new TenantUnavailableError(`tenant is ${entry.tenant.status}`);
      }
      return {
        tenantId: entry.tenant.id,
        actor: entry.actor,
        limits: entry.tenant.limits,
        role: entry.role,
        integrationId: entry.integrationId,
      };
    },
  };
}
