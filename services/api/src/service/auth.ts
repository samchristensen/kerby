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

export interface Authenticator {
  /** Resolve a presented credential: an API key, or a console session token. Throws `UnauthorizedError` or `TenantUnavailableError`. */
  authenticate(presented: string): Promise<Principal>;
}

/** A person in the console acts as the tenant: every scope, everything visible, attributed to no integration (ADR 0020). */
const CONSOLE_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

/**
 * Who a verified API key or console session is. `actor` is for the audit log: `key:<id>` or `user:<id>`. A key acts for
 * its integration with that integration's scopes, and sees only its own work unless it holds `tenant`.
 */
async function resolve(
  control: ControlDb,
  presented: string,
): Promise<{ tenant: TenantRecord; identity: Identity } | undefined> {
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
 * Verifies credentials against the control plane and trusts a verified one for `ttlMs`. Suspension, revocation, sign-out,
 * deletion and a change of an integration's scopes therefore take effect within one TTL (ADR 0004, 0020). Failures are
 * never cached: a wrong key costs a lookup.
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
        entry = { tenant: found.tenant, identity: found.identity, expiresAt: now() + ttlMs };
        if (ttlMs > 0) cache.set(cacheKey, entry);
      }
      if (entry.tenant.status !== "active") {
        throw new TenantUnavailableError(`tenant is ${entry.tenant.status}`);
      }
      return { tenantId: entry.tenant.id, ...entry.identity, limits: entry.tenant.limits };
    },
  };
}
