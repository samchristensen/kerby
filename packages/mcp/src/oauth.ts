// Kerby as an OAuth client of a remote MCP server (MCP authorization, revision 2026-07-28), on the `fetch` it is given
// (the egress guard): finding the authorization server (RFC 9728 protected resource metadata, RFC 8414 / OpenID
// discovery), registering a client (a Client ID Metadata Document, else RFC 7591 dynamic registration), the
// authorization request (PKCE S256 per RFC 7636, `state`, RFC 8707 `resource`), RFC 9207's issuer check, and the token
// endpoint (code exchange, refresh with rotation). Messages name hosts, never paths, tokens or secrets.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  isRecord,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  MODERN_VERSION,
} from "./protocol.ts";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What is read of one metadata, registration or token response. */
const MAX_RESPONSE_CHARS = 256 * 1024;
/** What is kept of an authorization server's `error_description`. */
const MAX_DESCRIPTION_CHARS = 300;

/**
 * Connecting or refreshing failed. `code` is the authorization server's `error` when it sent one: `invalid_grant` means
 * the grant (code or refresh token) is dead and the person must connect again.
 */
export class OAuthError extends Error {
  override name = "OAuthError";
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const ClientAuthSchema = z.enum(["none", "client_secret_basic", "client_secret_post"]);
/** How Kerby authenticates at the token endpoint: a public client (`none`), or with a registered secret. */
type OAuthClientAuth = z.infer<typeof ClientAuthSchema>;

/**
 * A connection's tokens and what refreshing them needs: the JSON sealed as an `oauth` server's credential. Only a
 * worker opens it; nothing returns it.
 */
const OAuthCredentialSchema = z.object({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).exactOptional(),
  /** When the access token expires, if the authorization server said. */
  expiresAt: z.iso.datetime().exactOptional(),
  tokenEndpoint: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  clientSecret: z.string().exactOptional(),
  clientAuth: ClientAuthSchema,
  /** The RFC 8707 resource the tokens are for: the MCP server they may be sent to. */
  resource: z.string(),
  scope: z.string().exactOptional(),
});
export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

/** A stored credential as an OAuth connection, or undefined when it is not one (a header's value). */
export function parseOAuthCredential(value: string): OAuthCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return OAuthCredentialSchema.safeParse(parsed).data;
}

/** Whether `url` is `resource` or below it (same origin, a path under it): the server a token for `resource` may see. */
export function isWithinResource(url: string, resource: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(resource);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

// --- reading what servers answer -------------------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
};

const why = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function send(
  fetch: Fetch,
  url: string,
  init: RequestInit,
  doing: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new OAuthError(`${doing} at ${hostOf(url)} failed: ${why(error)}`);
  }
}

async function bodyJson(response: Response, doing: string, url: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new OAuthError(`${doing} at ${hostOf(url)} failed: ${why(error)}`);
  }
  if (text.length > MAX_RESPONSE_CHARS)
    throw new OAuthError(
      `${doing} at ${hostOf(url)} answered more than ${MAX_RESPONSE_CHARS} characters`,
    );
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An authorization server's `{ error, error_description }`, cut short and on one line. */
function serverError(body: unknown): { code: string; text: string } | undefined {
  if (!isRecord(body) || typeof body.error !== "string") return undefined;
  const code = body.error.slice(0, 64);
  const description =
    typeof body.error_description === "string"
      ? body.error_description.replace(/\p{Cc}+/gu, " ").slice(0, MAX_DESCRIPTION_CHARS)
      : "";
  return { code, text: description ? `${code}: ${description}` : code };
}

/**
 * `url` must be https, except where `insecure` allows plain http (a development host): the spec requires https for
 * every authorization server endpoint, and a token is a credential.
 */
function checkedUrl(value: unknown, what: string, insecure: (url: URL) => boolean): string {
  if (typeof value !== "string") throw new OAuthError(`${what} is missing`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(`${what} is not a URL`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && insecure(url))) return value;
  throw new OAuthError(`${what} (${url.host}) must use https`);
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

// --- discovery ---------------------------------------------------------------------------------------------------

/** The `Bearer` challenge's parameters in a `WWW-Authenticate` header (RFC 6750 section 3, RFC 9728 section 5.1). */
function bearerChallenge(header: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  if (!header) return params;
  const start = header.search(/(^|[\s,])Bearer(\s|$)/i);
  if (start < 0) return params;
  const rest = header.slice(start).replace(/^[\s,]*Bearer/i, "");
  const pattern = /\s*,?\s*([A-Za-z0-9_.-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^\s,]+)/y;
  for (;;) {
    const match = pattern.exec(rest);
    if (!match?.[1] || match[2] === undefined) break;
    const key = match[1].toLowerCase();
    params[key] ??= match[3] === undefined ? match[2] : match[3].replace(/\\(.)/g, "$1");
  }
  return params;
}

/** RFC 9728 section 3: the server's path under the well-known prefix, then the root one. */
function resourceMetadataUrls(serverUrl: URL): string[] {
  const path = serverUrl.pathname.replace(/\/+$/, "");
  const root = `${serverUrl.origin}/.well-known/oauth-protected-resource`;
  return path === "" ? [root] : [`${root}${path}`, root];
}

/** RFC 8414 section 3.1 and 5, in the order MCP's discovery lists them. */
function authorizationServerMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  const { origin } = issuer;
  return path === ""
    ? [
        `${origin}/.well-known/oauth-authorization-server`,
        `${origin}/.well-known/openid-configuration`,
      ]
    : [
        `${origin}/.well-known/oauth-authorization-server${path}`,
        `${origin}/.well-known/openid-configuration${path}`,
        `${origin}${path}/.well-known/openid-configuration`,
      ];
}

/** What connecting to one MCP server needs to know about it and its authorization server. */
export type OAuthDiscovery = {
  /** The RFC 8707 resource to ask tokens for: the server's protected resource metadata `resource`. */
  resource: string;
  /** The scope the server's challenge names, else every scope its metadata supports; undefined: ask for none. */
  scope: string | undefined;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | undefined;
  /** The authorization server takes a Client ID Metadata Document URL as a client id. */
  clientIdMetadataDocuments: boolean;
  /** RFC 9207: it puts `iss` in every authorization response, so one without it is refused. */
  issParameterSupported: boolean;
  tokenEndpointAuthMethods: string[] | undefined;
  /** The authorization server's own `scopes_supported`. */
  scopesSupported: string[] | undefined;
};

/**
 * Find the authorization server of the MCP server at `url`: an unauthenticated request's 401 names its protected
 * resource metadata (else the well-known URIs), whose first authorization server's metadata is read (RFC 8414, then
 * OpenID discovery) and checked: the issuer it states, PKCE with S256, https endpoints.
 */
export async function discoverOAuth(options: {
  url: string;
  fetch: Fetch;
  signal?: AbortSignal;
  /** Plain http allowed for this URL (development hosts only). */
  insecure?: (url: URL) => boolean;
}): Promise<OAuthDiscovery> {
  const { fetch, signal } = options;
  const insecure = options.insecure ?? (() => false);
  const serverUrl = new URL(checkedUrl(options.url, "the MCP server's URL", insecure));
  const init = (extra: RequestInit): RequestInit => ({ ...extra, ...(signal ? { signal } : {}) });

  // 1. An unauthenticated request: its 401 says where the metadata is, and what scope the server wants.
  const probe = await send(
    fetch,
    serverUrl.href,
    init({
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MODERN_VERSION,
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { [META_PROTOCOL_VERSION]: MODERN_VERSION, [META_CLIENT_CAPABILITIES]: {} },
        },
      }),
    }),
    "asking the MCP server what authorization it needs",
  );
  await probe.body?.cancel().catch(() => {});
  const challenge =
    probe.status === 401 ? bearerChallenge(probe.headers.get("www-authenticate")) : {};

  // 2. The protected resource metadata: where the 401 points, else the well-known URIs.
  const pointed = challenge.resource_metadata;
  const candidates = pointed
    ? [checkedUrl(pointed, "the MCP server's resource_metadata", insecure)]
    : resourceMetadataUrls(serverUrl);
  let resourceMetadata: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const response = await send(
      fetch,
      candidate,
      init({ headers: { accept: "application/json" } }),
      "reading the MCP server's protected resource metadata",
    );
    const body = response.ok
      ? await bodyJson(response, "reading protected resource metadata", candidate)
      : await response.body?.cancel().catch(() => {});
    if (isRecord(body)) {
      resourceMetadata = body;
      break;
    }
  }
  if (!resourceMetadata)
    throw new OAuthError(
      `the MCP server at ${serverUrl.host} publishes no OAuth protected resource metadata (RFC 9728)${pointed ? "" : ": its 401 names none and the well-known URIs have none"}, so Kerby cannot find its authorization server`,
    );
  const resource = resourceMetadata.resource;
  if (typeof resource !== "string" || !isWithinResource(serverUrl.href, resource))
    throw new OAuthError(
      `the protected resource metadata of ${serverUrl.host} names a resource that is not this server's address: check the server's URL`,
    );
  const issuer = stringList(resourceMetadata.authorization_servers)?.[0];
  if (issuer === undefined)
    throw new OAuthError(
      `the protected resource metadata of ${serverUrl.host} names no authorization server`,
    );
  const issuerUrl = new URL(checkedUrl(issuer, "the authorization server's issuer", insecure));

  // 3. The authorization server's metadata, which must state the issuer it was asked for.
  let metadata: Record<string, unknown> | undefined;
  for (const candidate of authorizationServerMetadataUrls(issuerUrl)) {
    const response = await send(
      fetch,
      candidate,
      init({ headers: { accept: "application/json" } }),
      "reading the authorization server's metadata",
    );
    const body = response.ok
      ? await bodyJson(response, "reading authorization server metadata", candidate)
      : await response.body?.cancel().catch(() => {});
    if (isRecord(body)) {
      metadata = body;
      break;
    }
  }
  if (!metadata)
    throw new OAuthError(
      `the authorization server ${issuerUrl.host} publishes no metadata (RFC 8414 or OpenID discovery)`,
    );
  if (metadata.issuer !== issuer)
    throw new OAuthError(
      `the authorization server metadata at ${issuerUrl.host} states another issuer than the one asked for: refusing it`,
    );
  if (!stringList(metadata.code_challenge_methods_supported)?.includes("S256"))
    throw new OAuthError(
      `the authorization server ${issuerUrl.host} does not support PKCE with S256, which MCP requires`,
    );
  const responseTypes = stringList(metadata.response_types_supported);
  if (responseTypes && !responseTypes.includes("code"))
    throw new OAuthError(
      `the authorization server ${issuerUrl.host} does not offer the authorization code flow`,
    );
  const registration = metadata.registration_endpoint;

  const challengeScope = challenge.scope?.trim();
  const supported = stringList(resourceMetadata.scopes_supported);
  return {
    resource,
    scope: challengeScope || (supported && supported.length > 0 ? supported.join(" ") : undefined),
    issuer,
    authorizationEndpoint: checkedUrl(
      metadata.authorization_endpoint,
      "the authorization endpoint",
      insecure,
    ),
    tokenEndpoint: checkedUrl(metadata.token_endpoint, "the token endpoint", insecure),
    registrationEndpoint:
      registration === undefined
        ? undefined
        : checkedUrl(registration, "the registration endpoint", insecure),
    clientIdMetadataDocuments: metadata.client_id_metadata_document_supported === true,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    tokenEndpointAuthMethods: stringList(metadata.token_endpoint_auth_methods_supported),
    scopesSupported: stringList(metadata.scopes_supported),
  };
}

// --- the client and the authorization request ---------------------------------------------------------------------

/** Kerby's client id at one authorization server, and the secret and method it authenticates with, if any. */
export type OAuthClient = {
  clientId: string;
  clientSecret: string | undefined;
  clientAuth: OAuthClientAuth;
};

/**
 * RFC 7591 dynamic registration of Kerby as a public client (`token_endpoint_auth_method: none`, PKCE). A server that
 * issues a secret anyway gets it back at the token endpoint the way it registered.
 */
export async function registerOAuthClient(options: {
  fetch: Fetch;
  signal?: AbortSignal;
  registrationEndpoint: string;
  redirectUri: string;
}): Promise<OAuthClient> {
  const { registrationEndpoint, redirectUri } = options;
  const host = new URL(redirectUri).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const response = await send(
    options.fetch,
    registrationEndpoint,
    {
      method: "POST",
      redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Kerby",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        // A console on this machine is a native client to OpenID servers; a hosted one is a web client.
        application_type: local ? "native" : "web",
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    "registering Kerby as a client",
  );
  const body = await bodyJson(response, "registering Kerby as a client", registrationEndpoint);
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.client_id !== "string" ||
    body.client_id === ""
  ) {
    const refused = serverError(body);
    throw new OAuthError(
      `the authorization server ${hostOf(registrationEndpoint)} refused to register Kerby (HTTP ${response.status})${refused ? `: ${refused.text}` : ""}`,
      refused?.code,
    );
  }
  const secret =
    typeof body.client_secret === "string" && body.client_secret !== ""
      ? body.client_secret
      : undefined;
  const method = ClientAuthSchema.safeParse(body.token_endpoint_auth_method).data;
  if (secret === undefined || method === "none")
    return { clientId: body.client_id, clientSecret: undefined, clientAuth: "none" };
  // RFC 7591: a client registered without saying is client_secret_basic.
  return {
    clientId: body.client_id,
    clientSecret: secret,
    clientAuth: method ?? "client_secret_basic",
  };
}

/** RFC 7636 with S256: a random verifier, kept until the code is exchanged, and its challenge, sent now. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where to send the person's browser: the authorization endpoint with the request's parameters added to its own. */
export function authorizationUrl(request: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string | undefined;
}): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", request.state);
  url.searchParams.set("resource", request.resource);
  if (request.scope !== undefined) url.searchParams.set("scope", request.scope);
  return url.href;
}

/**
 * RFC 9207 as MCP applies it to an authorization response: a present `iss` must equal the recorded issuer exactly; an
 * absent one is refused only from an issuer that said it always sends one. Undefined when the response may be used;
 * otherwise why not (and then nothing in the response may be acted on or shown, its error included).
 */
export function issuerProblem(
  recorded: string,
  issRequired: boolean,
  iss: string | undefined,
): string | undefined {
  if (iss === undefined)
    return issRequired
      ? "the authorization server's answer carries no iss, though it says it always sends one"
      : undefined;
  return iss === recorded
    ? undefined
    : "the answer names another authorization server (iss) than the one Kerby asked: it may be a mix-up attack";
}

// --- the token endpoint ------------------------------------------------------------------------------------------

/** What the token endpoint needs to know about the client and the resource. */
type TokenClient = Pick<
  OAuthCredential,
  "tokenEndpoint" | "issuer" | "clientId" | "clientSecret" | "clientAuth" | "resource" | "scope"
>;

/** A form value as `application/x-www-form-urlencoded` writes it (RFC 6749 section 2.3.1, for HTTP Basic). */
const formEncoded = (value: string): string =>
  new URLSearchParams([["", value]]).toString().slice(1);

/** One visible-ASCII token without spaces: safe in an Authorization header. */
const TOKEN = /^[\x21-\x7E]+$/;

async function tokenRequest(
  fetch: Fetch,
  client: TokenClient,
  grant: Record<string, string>,
  previous: Pick<OAuthCredential, "refreshToken"> | undefined,
  signal: AbortSignal | undefined,
): Promise<OAuthCredential> {
  const form = new URLSearchParams(grant);
  form.set("resource", client.resource);
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (client.clientAuth === "client_secret_basic" && client.clientSecret !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${formEncoded(client.clientId)}:${formEncoded(client.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.clientAuth === "client_secret_post" && client.clientSecret !== undefined)
      form.set("client_secret", client.clientSecret);
  }
  const doing =
    grant.grant_type === "refresh_token" ? "refreshing the token" : "exchanging the code";
  const response = await send(
    fetch,
    client.tokenEndpoint,
    {
      method: "POST",
      redirect: "error",
      headers,
      body: form.toString(),
      ...(signal ? { signal } : {}),
    },
    doing,
  );
  const body = await bodyJson(response, doing, client.tokenEndpoint);
  const host = hostOf(client.tokenEndpoint);
  if (!response.ok) {
    const refused = serverError(body);
    throw new OAuthError(
      `${doing} at ${host} was refused (HTTP ${response.status})${refused ? `: ${refused.text}` : ""}`,
      refused?.code,
    );
  }
  if (!isRecord(body) || typeof body.access_token !== "string" || !TOKEN.test(body.access_token))
    throw new OAuthError(`${doing} at ${host} returned no usable access token`);
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer")
    throw new OAuthError(`${doing} at ${host} returned a token that is not a Bearer token`);
  const lifetime = Number(body.expires_in);
  const refreshToken =
    typeof body.refresh_token === "string" && TOKEN.test(body.refresh_token)
      ? body.refresh_token
      : previous?.refreshToken;
  const scope = typeof body.scope === "string" ? body.scope : client.scope;
  return {
    kind: "oauth",
    accessToken: body.access_token,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(body.expires_in !== undefined && Number.isFinite(lifetime) && lifetime >= 0
      ? { expiresAt: new Date(Date.now() + lifetime * 1000).toISOString() }
      : {}),
    tokenEndpoint: client.tokenEndpoint,
    issuer: client.issuer,
    clientId: client.clientId,
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
    clientAuth: client.clientAuth,
    resource: client.resource,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** Exchange an authorization code (with its PKCE verifier and the same `resource`) for the connection's tokens. */
export function exchangeOAuthCode(options: {
  fetch: Fetch;
  signal?: AbortSignal;
  client: TokenClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthCredential> {
  return tokenRequest(
    options.fetch,
    options.client,
    {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
    },
    undefined,
    options.signal,
  );
}

/**
 * New tokens for a connection with its refresh token (and the same `resource`). A rotated refresh token replaces the
 * old one, which the authorization server will not take again; without a new one the old one is kept.
 */
export function refreshOAuthCredential(options: {
  fetch: Fetch;
  signal?: AbortSignal;
  credential: OAuthCredential & { refreshToken: string };
}): Promise<OAuthCredential> {
  const { credential } = options;
  return tokenRequest(
    options.fetch,
    credential,
    { grant_type: "refresh_token", refresh_token: credential.refreshToken },
    credential,
    options.signal,
  );
}
