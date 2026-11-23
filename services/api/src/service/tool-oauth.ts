// Connecting a tool server with OAuth (ADR 0019; MCP authorization, revision 2026-07-28). The console starts a
// connection here and sends the person's browser to the authorization server; the browser comes back to the console,
// which hands the answer here to finish it. Every request to the tenant's server and its authorization server goes
// through the egress guard. The api seals the tokens and never reads them back: only a worker opens and refreshes them.
import { randomBytes } from "node:crypto";
import {
  type FinishToolServerOAuthRequest,
  type KerbyOAuthClient,
  kerbyOAuthClient,
  type StartToolServerOAuthResponse,
  type ToolServer,
} from "@kerby/contracts";
import { audit, putToolCredential } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import {
  authorizationUrl,
  createPkce,
  discoverOAuth,
  exchangeOAuthCode,
  issuerProblem,
  type OAuthClient,
  type OAuthCredential,
  type OAuthDiscovery,
  OAuthError,
  registerOAuthClient,
} from "@kerby/mcp";
import { findToolServerById, saveOAuthFlow, takeOAuthFlow, updateToolServer } from "@kerby/tools";
import type { ApiDeps, Principal } from "../types/index.ts";
import {
  checkOAuthUrl,
  enqueueSync,
  notifyWorkers,
  remoteServer,
  serverResource,
  ToolServerRequestError,
} from "./tools.ts";

/** Discovery and registration together, at most. */
const START_TIMEOUT_MS = 30_000;
/** What is shown of an authorization server's `error_description`. */
const MAX_DESCRIPTION_CHARS = 300;

type OAuthFlowCode =
  | "oauth_not_configured"
  | "oauth_failed"
  | "oauth_state_unknown"
  | "oauth_state_expired"
  | "oauth_issuer_mismatch"
  | "oauth_denied";

/** A connection that cannot start or finish; `code` is the API error code, the message says what to do. */
export class OAuthFlowError extends Error {
  override name = "OAuthFlowError";
  readonly code: OAuthFlowCode;

  constructor(code: OAuthFlowCode, message: string) {
    super(message);
    this.code = code;
  }
}

const AGAIN = "connect again from the server's page";

/**
 * `POST /v1/tool-servers/:slug/oauth/start`: find the server's authorization server, get a client id there (Kerby's
 * Client ID Metadata Document where it is supported, else dynamic registration), keep the flow for ten minutes, and
 * return where to send the person's browser.
 */
export async function startToolServerOAuth(
  deps: ApiDeps,
  ctx: TenantContext,
  slug: string,
): Promise<StartToolServerOAuthResponse> {
  const consoleUrl = deps.settings.consolePublicUrl;
  if (consoleUrl === undefined)
    throw new OAuthFlowError(
      "oauth_not_configured",
      "OAuth needs CONSOLE_PUBLIC_URL: the operator sets the console's public address on the api, where Kerby's redirect URI and client id live",
    );
  const server = await remoteServer(ctx.db, slug);
  if (server.auth.kind !== "oauth" || server.url === null)
    throw new ToolServerRequestError(
      `this server does not use OAuth: PATCH /v1/tool-servers/${slug} with auth.kind oauth first`,
    );
  checkOAuthUrl(deps, server.url);
  const kerby = kerbyOAuthClient(consoleUrl);
  const signal = AbortSignal.timeout(START_TIMEOUT_MS);
  const insecure = (url: URL) =>
    url.protocol === "http:" && deps.settings.insecureOAuthHosts.includes(url.hostname);
  let started: { discovery: OAuthDiscovery; client: OAuthClient };
  try {
    const discovery = await discoverOAuth({
      url: server.url,
      fetch: deps.toolFetch,
      signal,
      insecure,
    });
    started = { discovery, client: await clientAt(deps, discovery, kerby, signal) };
  } catch (error) {
    if (error instanceof OAuthError)
      throw new OAuthFlowError("oauth_failed", `connecting ${slug} failed: ${error.message}`);
    throw error;
  }
  const { discovery, client } = started;
  const scope = server.auth.scope ?? withOfflineAccess(discovery.scope, discovery.scopesSupported);
  const pkce = createPkce();
  const state = randomBytes(32).toString("base64url");
  await saveOAuthFlow(ctx.db, state, {
    serverId: server.id,
    serverUrl: server.url,
    codeVerifier: pkce.verifier,
    issuer: discovery.issuer,
    issRequired: discovery.issParameterSupported,
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret ?? null,
    clientAuth: client.clientAuth,
    redirectUri: kerby.redirectUri,
    resource: discovery.resource,
    scope: scope ?? null,
  });
  return {
    authorizationUrl: authorizationUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: kerby.redirectUri,
      codeChallenge: pkce.challenge,
      state,
      resource: discovery.resource,
      scope,
    }),
  };
}

/** Kerby's client id at the authorization server, by the spec's order: a Client ID Metadata Document, else registration. */
async function clientAt(
  deps: ApiDeps,
  discovery: OAuthDiscovery,
  kerby: KerbyOAuthClient,
  signal: AbortSignal,
): Promise<OAuthClient> {
  // A metadata document must be served over https: a console on plain http (a local stack) registers instead.
  if (discovery.clientIdMetadataDocuments && kerby.clientId.startsWith("https://"))
    return { clientId: kerby.clientId, clientSecret: undefined, clientAuth: "none" };
  if (discovery.registrationEndpoint !== undefined)
    return registerOAuthClient({
      fetch: deps.toolFetch,
      signal,
      registrationEndpoint: discovery.registrationEndpoint,
      redirectUri: kerby.redirectUri,
    });
  throw new OAuthError(
    discovery.clientIdMetadataDocuments
      ? `the authorization server ${new URL(discovery.issuer).host} takes only Client ID Metadata Documents, which must be served over https: set CONSOLE_PUBLIC_URL to the console's https address`
      : `the authorization server ${new URL(discovery.issuer).host} offers neither Client ID Metadata Documents (client_id_metadata_document_supported) nor dynamic registration (registration_endpoint), so Kerby cannot get a client id there`,
  );
}

/** MCP lets a client ask for `offline_access` (a refresh token) when the authorization server lists it. */
function withOfflineAccess(scope: string | undefined, supported: string[] | undefined) {
  if (scope === undefined || !supported?.includes("offline_access")) return scope;
  return scope.split(" ").includes("offline_access") ? scope : `${scope} offline_access`;
}

/**
 * `POST /v1/tool-servers/oauth/callback`: finish the connection the authorization server answered. The flow is found by
 * `state` in the caller's own tenant database, so an answer can only land in the tenant that began it; it is used
 * once. RFC 9207's issuer check comes before anything in the answer is used or shown. The code is exchanged through
 * the egress guard, the tokens sealed, and the server's tools listed again with them.
 */
export async function finishToolServerOAuth(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  request: FinishToolServerOAuthRequest,
): Promise<ToolServer> {
  const flow = await takeOAuthFlow(ctx.db, request.state);
  if (!flow)
    throw new OAuthFlowError(
      "oauth_state_unknown",
      `no connection of this workspace is waiting for this answer: it finished already, was replaced by a newer one, or was begun elsewhere. ${AGAIN}`,
    );
  if (flow.expiresAt.getTime() <= Date.now())
    throw new OAuthFlowError(
      "oauth_state_expired",
      `the connection was not approved within 10 minutes: ${AGAIN}`,
    );
  const problem = issuerProblem(flow.issuer, flow.issRequired, request.iss);
  if (problem)
    throw new OAuthFlowError(
      "oauth_issuer_mismatch",
      `${problem}. Nothing in the answer was used: ${AGAIN}`,
    );
  const server = await findToolServerById(ctx.db, flow.serverId);
  const slug = server?.slug ?? "the server";
  if (request.error !== undefined) {
    const description = request.errorDescription
      ?.replace(/\p{Cc}+/gu, " ")
      .slice(0, MAX_DESCRIPTION_CHARS);
    throw new OAuthFlowError(
      "oauth_denied",
      `the authorization server did not connect ${slug}: ${request.error.slice(0, 64)}${description ? ` (${description})` : ""}`,
    );
  }
  if (server?.auth.kind !== "oauth" || server.url !== flow.serverUrl)
    throw new OAuthFlowError(
      "oauth_state_unknown",
      `the server was changed or deleted since the connection began: ${AGAIN}`,
    );
  let credential: OAuthCredential;
  try {
    credential = await exchangeOAuthCode({
      fetch: deps.toolFetch,
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      client: {
        tokenEndpoint: flow.tokenEndpoint,
        issuer: flow.issuer,
        clientId: flow.clientId,
        ...(flow.clientSecret === null ? {} : { clientSecret: flow.clientSecret }),
        clientAuth: flow.clientAuth,
        resource: flow.resource,
        ...(flow.scope === null ? {} : { scope: flow.scope }),
      },
      code: request.code ?? "",
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
  } catch (error) {
    if (error instanceof OAuthError)
      throw new OAuthFlowError(
        "oauth_failed",
        `connecting ${slug} failed: ${error.message}. ${AGAIN}`,
      );
    throw error;
  }
  const updated = await ctx.db.transaction(async (tx) => {
    // Locks the server's row until the tokens are stored: a change of its URL or auth waits, or went first and wins.
    const locked = await updateToolServer(tx, server.id, {});
    if (locked.auth.kind !== "oauth" || locked.url !== flow.serverUrl)
      throw new OAuthFlowError(
        "oauth_state_unknown",
        `the server was changed since the connection began: ${AGAIN}`,
      );
    await putToolCredential(
      deps.control,
      deps.sealer,
      ctx.tenantId,
      server.id,
      JSON.stringify(credential),
    );
    await enqueueSync(tx, server.id);
    return locked;
  });
  await notifyWorkers(deps, ctx.tenantId);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.oauth",
    detail: { serverId: updated.id, slug: updated.slug },
  });
  return serverResource(deps, ctx, updated);
}
