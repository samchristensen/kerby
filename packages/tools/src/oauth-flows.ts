// OAuth connections the console began and the authorization server has not answered yet (ADR 0019): what the api
// reads back when the person's browser returns with a code. A flow is found only by its `state`, which is stored
// hashed, read once (taken), and dies after ten minutes. It lives in the tenant's own database, so a state can only
// ever finish a connection of the tenant whose session began it.
import { createHash } from "node:crypto";
import type { TenantQueryable } from "@kerby/db";

/** How long a person has to approve at the authorization server. */
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** Unfinished connections kept per server; starting another drops the oldest. */
const MAX_LIVE_FLOWS_PER_SERVER = 5;

export type OAuthFlow = {
  serverId: string;
  /** The server's URL when the flow began. */
  serverUrl: string;
  codeVerifier: string;
  issuer: string;
  /** The issuer advertised `authorization_response_iss_parameter_supported`: an answer without `iss` is refused. */
  issRequired: boolean;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  clientAuth: "none" | "client_secret_basic" | "client_secret_post";
  redirectUri: string;
  resource: string;
  scope: string | null;
  expiresAt: Date;
};

type FlowRow = {
  server_id: string;
  server_url: string;
  code_verifier: string;
  issuer: string;
  iss_required: boolean;
  token_endpoint: string;
  client_id: string;
  client_secret: string | null;
  client_auth: OAuthFlow["clientAuth"];
  redirect_uri: string;
  resource: string;
  scope: string | null;
  expires_at: Date;
};

const stateHash = (state: string): string => createHash("sha256").update(state).digest("base64url");

/**
 * Keep a flow under its `state` for ten minutes. Expired flows of every server go, and the server keeps at most
 * `MAX_LIVE_FLOWS_PER_SERVER` live ones (the newest).
 */
export async function saveOAuthFlow(
  db: TenantQueryable,
  state: string,
  flow: Omit<OAuthFlow, "expiresAt">,
): Promise<void> {
  await db.query("delete from tool_oauth_flows where expires_at < now()");
  await db.query(
    `insert into tool_oauth_flows (state_hash, server_id, server_url, code_verifier, issuer, iss_required,
       token_endpoint, client_id, client_secret, client_auth, redirect_uri, resource, scope, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + $14 * interval '1 millisecond')`,
    [
      stateHash(state),
      flow.serverId,
      flow.serverUrl,
      flow.codeVerifier,
      flow.issuer,
      flow.issRequired,
      flow.tokenEndpoint,
      flow.clientId,
      flow.clientSecret,
      flow.clientAuth,
      flow.redirectUri,
      flow.resource,
      flow.scope,
      OAUTH_FLOW_TTL_MS,
    ],
  );
  await db.query(
    `delete from tool_oauth_flows where server_id = $1 and state_hash not in (
       select state_hash from tool_oauth_flows where server_id = $1 order by created_at desc, state_hash limit $2)`,
    [flow.serverId, MAX_LIVE_FLOWS_PER_SERVER],
  );
}

/**
 * The flow begun with `state`, removed so that it can finish only once; undefined when there is none (never begun,
 * finished, dropped, or another tenant's). An expired flow is returned (and removed): the caller says it expired.
 */
export async function takeOAuthFlow(
  db: TenantQueryable,
  state: string,
): Promise<OAuthFlow | undefined> {
  const { rows } = await db.query<FlowRow>(
    `delete from tool_oauth_flows where state_hash = $1
     returning server_id, server_url, code_verifier, issuer, iss_required, token_endpoint, client_id, client_secret,
       client_auth, redirect_uri, resource, scope, expires_at`,
    [stateHash(state)],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    serverId: row.server_id,
    serverUrl: row.server_url,
    codeVerifier: row.code_verifier,
    issuer: row.issuer,
    issRequired: row.iss_required,
    tokenEndpoint: row.token_endpoint,
    clientId: row.client_id,
    clientSecret: row.client_secret,
    clientAuth: row.client_auth,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scope: row.scope,
    expiresAt: row.expires_at,
  };
}
