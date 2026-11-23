// What listing a tenant's MCP server and calling its tools share (ADR 0019): the credential in its header (a header's
// value, or an OAuth connection's access token, refreshed when it is about to expire or the server refuses it), and an
// account of a failure the tenant may read (a sync's `last_error`, a tool's error result) that never holds a credential.
import { EgressError } from "@kerby/egress";
import {
  headerSecrets,
  isWithinResource,
  McpError,
  type OAuthCredential,
  OAuthError,
  parseOAuthCredential,
  refreshOAuthCredential,
} from "@kerby/mcp";
import { log } from "@kerby/observability";
import type { ToolServerRecord } from "@kerby/tools";
import type { WorkerDeps } from "../types/index.ts";

export const MCP_CLIENT_INFO = { name: "kerby", version: "1" };

/** An access token this close to its expiry is refreshed before use. */
const REFRESH_WITHIN_MS = 60_000;
/** One refresh, at most; the credential's row stays locked meanwhile. */
const REFRESH_TIMEOUT_MS = 15_000;

type Server = Pick<ToolServerRecord, "id" | "slug" | "url" | "auth">;

/**
 * The headers a server's auth needs, and every secret in them or behind them (to scrub from anything the server
 * answers: a header's value, and the token of a `<scheme> <token>` value on its own); `accessToken` is the OAuth token
 * sent, for a refresh after a refusal. `missing` says why nothing can be sent.
 */
export type ServerAuth =
  | { headers: Record<string, string>; secrets: string[]; accessToken?: string }
  | { missing: string };

const notConnected = (slug: string) =>
  `"${slug}" is not connected: connect it in the console (its server page, or POST /v1/tool-servers/${slug}/oauth/start)`;
const expired = (slug: string) =>
  `the authorization expired: connect it again in the console ("${slug}", or POST /v1/tool-servers/${slug}/oauth/start)`;

/** The headers for `server`, opening its credential; an OAuth access token about to expire is refreshed first. */
export async function toolServerHeaders(
  deps: WorkerDeps,
  tenantId: string,
  server: Server,
  signal: AbortSignal,
): Promise<ServerAuth> {
  if (server.auth.kind === "none") return { headers: {}, secrets: [] };
  if (!deps.toolCredentials)
    return { missing: "this worker cannot open tool credentials: SECRETS_PRIVATE_KEYS is not set" };
  const stored = await deps.toolCredentials.read(tenantId, server.id);
  if (server.auth.kind === "header") {
    if (stored === undefined)
      return {
        missing: `no credential is stored for "${server.slug}": PUT /v1/tool-servers/${server.slug}/credential`,
      };
    return { headers: { [server.auth.header]: stored }, secrets: headerSecrets(stored) };
  }
  const credential = stored === undefined ? undefined : parseOAuthCredential(stored);
  if (!credential) return { missing: notConnected(server.slug) };
  if (!expiring(credential)) return bearer(server, credential);
  return refreshed(deps, tenantId, server, credential.accessToken, signal);
}

/**
 * After `error` from a request made with `used`: for an OAuth server that answered 401, the headers of a refreshed
 * token (or why there are none) to try once more with. Undefined when another try would not help.
 */
export function afterRefusal(
  deps: WorkerDeps,
  tenantId: string,
  server: Server,
  used: ServerAuth,
  error: unknown,
  signal: AbortSignal,
): Promise<ServerAuth> | undefined {
  if (
    server.auth.kind !== "oauth" ||
    !("accessToken" in used) ||
    used.accessToken === undefined ||
    !(error instanceof McpError && error.kind === "unauthorized" && error.status === 401)
  )
    return undefined;
  return refreshed(deps, tenantId, server, used.accessToken, signal);
}

const expiring = (credential: OAuthCredential): boolean =>
  credential.expiresAt !== undefined &&
  Date.parse(credential.expiresAt) - Date.now() < REFRESH_WITHIN_MS;

/** The bearer header of a connection, sent only to the server its tokens are for (RFC 8707). */
function bearer(server: Server, credential: OAuthCredential): ServerAuth {
  if (server.url === null || !isWithinResource(server.url, credential.resource))
    return {
      missing: `the stored authorization of "${server.slug}" is for another address: connect it again in the console`,
    };
  return {
    headers: { Authorization: `Bearer ${credential.accessToken}` },
    secrets: [credential.accessToken, credential.refreshToken, credential.clientSecret].filter(
      (secret): secret is string => secret !== undefined,
    ),
    accessToken: credential.accessToken,
  };
}

/**
 * Refresh an OAuth connection whose access token `stale` expires or was refused, under the lock on its stored
 * credential: two workers at once take turns, and the second uses the first's new tokens instead of spending the
 * refresh token again (a rotated one would be refused, and the authorization server may revoke the whole grant). A
 * dead grant (`invalid_grant`, or no refresh token) is deleted, so the console shows the server as not connected.
 */
async function refreshed(
  deps: WorkerDeps,
  tenantId: string,
  server: Server,
  stale: string,
  signal: AbortSignal,
): Promise<ServerAuth> {
  const store = deps.toolCredentials;
  if (!store) return { missing: notConnected(server.slug) };
  let outcome: OAuthCredential | { missing: string } | undefined;
  await store.update(tenantId, server.id, async (stored) => {
    const current = parseOAuthCredential(stored);
    if (!current) {
      outcome = { missing: notConnected(server.slug) };
      return undefined;
    }
    // Another worker refreshed since this one read it: use theirs.
    if (current.accessToken !== stale && !expiring(current)) {
      outcome = current;
      return undefined;
    }
    if (current.refreshToken === undefined) {
      outcome = { missing: expired(server.slug) };
      return null;
    }
    try {
      const fresh = await refreshOAuthCredential({
        fetch: deps.toolFetch,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]),
        credential: { ...current, refreshToken: current.refreshToken },
      });
      outcome = fresh;
      return JSON.stringify(fresh);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.code === "invalid_grant") {
        outcome = { missing: expired(server.slug) };
        return null;
      }
      let message = `refreshing the authorization of "${server.slug}" failed: ${error.message}`;
      for (const secret of [current.accessToken, current.refreshToken, current.clientSecret])
        if (secret !== undefined) message = message.replaceAll(secret, "[redacted]");
      outcome = { missing: message };
      return undefined;
    }
  });
  // A lost lease is not the server's failure.
  signal.throwIfAborted();
  if (outcome === undefined) return { missing: notConnected(server.slug) };
  return "missing" in outcome ? outcome : bearer(server, outcome);
}

/**
 * Why an exchange with `server` failed, in words the tenant can act on, with every credential scrubbed out. An egress
 * refusal of a private address names the host only (its message names the address the host resolved to, which goes
 * to the operator's log instead).
 */
export function whyToolFailed(
  error: unknown,
  secrets: readonly string[],
  doing: string,
  server: Pick<ToolServerRecord, "url" | "auth">,
): string {
  let why: string;
  if (error instanceof McpError && error.kind === "unauthorized")
    why =
      server.auth.kind === "oauth"
        ? error.status === 403
          ? "the server refused the authorization (HTTP 403): it may need another scope; set the server's scope and connect it again in the console"
          : "the server refused the authorization (HTTP 401): connect it again in the console"
        : `the server refused the credential (HTTP ${error.status ?? "401"}): check it with PUT /v1/tool-servers/<server>/credential`;
  else if (error instanceof McpError) why = error.message;
  else if (error instanceof EgressError && error.reason === "timeout")
    why = "the server did not answer in time";
  else if (error instanceof EgressError && error.reason === "blocked_address") {
    const host = server.url === null ? "the server" : new URL(server.url).hostname;
    why = `the address was refused (blocked_address): ${host} is not a public address, and Kerby reaches public addresses only`;
    log("warn", "egress refused a tool server's address", {
      reason: error.reason,
      detail: error.message,
    });
  } else if (error instanceof EgressError)
    why = `the address was refused (${error.reason}): ${error.message}`;
  else if (error instanceof DOMException && error.name === "TimeoutError")
    why = "the server did not answer in time";
  else why = error instanceof Error ? error.message : String(error);
  let text = `${doing} failed: ${why}`;
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text;
}
