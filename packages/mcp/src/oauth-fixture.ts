// An MCP server behind OAuth, for tests (MCP authorization, 2026-07-28): the MCP fixture answering 401 with a Bearer
// challenge until it gets a token it issued, its protected resource metadata (RFC 9728), and an authorization server
// on a port of its own (RFC 8414 metadata, RFC 7591 registration, an authorize endpoint that approves at once, a token
// endpoint that checks PKCE and `resource` and rotates refresh tokens). Not for production.
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type McpFixture, type McpFixtureOptions, startMcpFixture } from "./testing.ts";

export type OAuthFixtureOptions = Omit<
  McpFixtureOptions,
  "mode" | "requiredHeader" | "intercept" | "listenHost" | "urlHost"
> & {
  /** The MCP server's protocol era; default `stateless`. */
  mode?: McpFixtureOptions["mode"];
  /**
   * Where the protected resource metadata is found: named by the 401's `resource_metadata` (`challenge`, the default),
   * or only at a well-known URI (`path`: with the MCP endpoint's path, `root`: at the root).
   */
  metadataAt?: "challenge" | "path" | "root";
  /** The 401's `scope`. */
  challengeScope?: string;
  /** The protected resource metadata's `scopes_supported`. */
  scopesSupported?: string[];
  /** The authorization server takes Client ID Metadata Document URLs as client ids. Default false. */
  clientIdMetadataDocuments?: boolean;
  /** The authorization server offers dynamic registration. Default true. */
  registration?: boolean;
  /** The authorization server lists S256 among its PKCE methods. Default true. */
  pkce?: boolean;
  /** Seconds an access token lives; default 3600. `setTokenLifetime` changes it later. */
  tokenLifetimeSeconds?: number;
  /** Address both servers listen on; default 127.0.0.1. */
  listenHost?: string;
  /** Host name in every URL the fixture gives out; default the listen address. */
  urlHost?: string;
  /** Host name of the authorize endpoint, which a person's browser opens; default `urlHost`. */
  browserHost?: string;
};

type Grant = { clientId: string; resource: string; scope: string | undefined };

export type OAuthFixture = AsyncDisposable & {
  /** The MCP server: its `url`, the requests it saw, the calls that reached a tool. */
  mcp: McpFixture;
  /** The authorization server's issuer identifier. */
  issuer: string;
  /** Each dynamic registration's request body. */
  registrations: Record<string, unknown>[];
  /** Each authorization request's query. */
  authorizations: URLSearchParams[];
  /** Each token request's form. */
  tokenRequests: URLSearchParams[];
  /** Access tokens issued from now on live this long. */
  setTokenLifetime(seconds: number): void;
  /** Authorization responses carry this `iss` instead of the issuer (a mix-up); null leaves it out. */
  setIss(iss: string | null): void;
  /** Authorization requests are denied (`error=access_denied`) from now on. */
  setDenying(deny: boolean): void;
  /** Tokens as a finished connection would hold them, issued without a browser to the client `clientId`. */
  grant(options?: { clientId?: string; lifetimeSeconds?: number }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    clientId: string;
  };
  /** Every access and refresh token issued so far stops working. */
  revoke(): void;
  close(): Promise<void>;
};

const token = (): string => randomBytes(24).toString("base64url");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function formOf(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Starts the MCP server and its authorization server on ephemeral ports. */
export async function startOAuthFixture(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
  const listenHost = options.listenHost ?? "127.0.0.1";
  const urlHost = options.urlHost ?? listenHost;
  const metadataAt = options.metadataAt ?? "challenge";
  let lifetime = options.tokenLifetimeSeconds ?? 3600;
  let issOverride: string | null | undefined;
  let denying = false;
  const registrations: Record<string, unknown>[] = [];
  const authorizations: URLSearchParams[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const clients = new Map<string, string[]>();
  const codes = new Map<string, Grant & { redirectUri: string; challenge: string }>();
  const accessTokens = new Map<string, { expiresAt: number; resource: string }>();
  const refreshTokens = new Map<string, Grant>();

  let issuer = "";
  let resource = "";
  const metadataPath =
    metadataAt === "challenge"
      ? "/oauth/resource-metadata"
      : metadataAt === "path"
        ? "/.well-known/oauth-protected-resource/mcp"
        : "/.well-known/oauth-protected-resource";

  function issue(grant: Grant): { accessToken: string; refreshToken: string; expiresIn: number } {
    const accessToken = token();
    const refreshToken = token();
    accessTokens.set(accessToken, {
      expiresAt: Date.now() + lifetime * 1000,
      resource: grant.resource,
    });
    refreshTokens.set(refreshToken, grant);
    return { accessToken, refreshToken, expiresIn: lifetime };
  }

  // The MCP server: metadata, then a Bearer token it issued, unexpired, for its own resource.
  const mcp = await startMcpFixture({
    ...options,
    mode: options.mode ?? "stateless",
    listenHost,
    urlHost,
    intercept(req, res) {
      const path = new URL(req.url ?? "/", "http://fixture").pathname;
      if (req.method === "GET" && path === metadataPath) {
        json(res, 200, {
          resource,
          authorization_servers: [issuer],
          bearer_methods_supported: ["header"],
          ...(options.scopesSupported ? { scopes_supported: options.scopesSupported } : {}),
        });
        return true;
      }
      const presented = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const known = presented === undefined ? undefined : accessTokens.get(presented);
      if (known && known.expiresAt > Date.now() && known.resource === resource) return false;
      const params = [
        ...(presented === undefined ? [] : ['error="invalid_token"']),
        ...(metadataAt === "challenge"
          ? [`resource_metadata="${new URL(metadataPath, resource).href}"`]
          : []),
        ...(options.challengeScope ? [`scope="${options.challengeScope}"`] : []),
      ];
      res.writeHead(401, {
        "www-authenticate": `Bearer${params.length > 0 ? ` ${params.join(", ")}` : ""}`,
        "content-type": "text/plain",
      });
      res.end("Unauthorized");
      return true;
    },
  });
  resource = mcp.url;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", issuer);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      const browserBase = `http://${options.browserHost ?? urlHost}:${new URL(issuer).port}`;
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${browserBase}/authorize`,
        token_endpoint: `${issuer}/token`,
        ...(options.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: options.pkce === false ? ["plain"] : ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        ...(options.clientIdMetadataDocuments
          ? { client_id_metadata_document_supported: true }
          : {}),
      });
    }
    if (req.method === "POST" && url.pathname === "/register" && options.registration !== false) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof body !== "object" || body === null)
        return json(res, 400, { error: "invalid_client_metadata" });
      const record = body as Record<string, unknown>;
      registrations.push(record);
      const redirects = Array.isArray(record.redirect_uris) ? record.redirect_uris.map(String) : [];
      if (redirects.length === 0) return json(res, 400, { error: "invalid_redirect_uri" });
      const clientId = `client-${token()}`;
      clients.set(clientId, redirects);
      return json(res, 201, {
        client_id: clientId,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
      });
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const query = url.searchParams;
      authorizations.push(query);
      const clientId = query.get("client_id") ?? "";
      const redirectUri = query.get("redirect_uri") ?? "";
      const registered = clients.get(clientId);
      const metadataDocument =
        options.clientIdMetadataDocuments === true && clientId.startsWith("https://");
      if (!(registered?.includes(redirectUri) || metadataDocument)) {
        res.writeHead(400, { "content-type": "text/plain" }).end("unknown client or redirect_uri");
        return;
      }
      const back = new URL(redirectUri);
      back.searchParams.set("state", query.get("state") ?? "");
      if (issOverride !== null) back.searchParams.set("iss", issOverride ?? issuer);
      const problem = denying
        ? "access_denied"
        : query.get("response_type") !== "code"
          ? "unsupported_response_type"
          : query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")
            ? "invalid_request"
            : query.get("resource") !== resource
              ? "invalid_target"
              : undefined;
      if (problem) {
        back.searchParams.set("error", problem);
        back.searchParams.set("error_description", `the fixture refused: ${problem}`);
      } else {
        const code = token();
        codes.set(code, {
          clientId,
          redirectUri,
          challenge: query.get("code_challenge") ?? "",
          resource,
          scope: query.get("scope") ?? undefined,
        });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.href }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = await formOf(req);
      tokenRequests.push(form);
      const fail = (error: string, description: string) =>
        json(res, 400, { error, error_description: description });
      if (form.get("resource") !== resource)
        return fail("invalid_target", "resource is not the MCP server");
      if (form.get("grant_type") === "authorization_code") {
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (!pending || pending.clientId !== form.get("client_id"))
          return fail("invalid_grant", "unknown or used code");
        if (pending.redirectUri !== form.get("redirect_uri"))
          return fail("invalid_grant", "redirect_uri differs");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (challenge !== pending.challenge)
          return fail("invalid_grant", "PKCE verification failed");
        const issued = issue(pending);
        return json(res, 200, {
          access_token: issued.accessToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
          ...(pending.scope ? { scope: pending.scope } : {}),
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";
        const grant = refreshTokens.get(presented);
        if (!grant || grant.clientId !== form.get("client_id"))
          return fail("invalid_grant", "unknown, used or revoked refresh token");
        // Rotation: the old refresh token is spent.
        refreshTokens.delete(presented);
        const issued = issue(grant);
        return json(res, 200, {
          access_token: issued.accessToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          refresh_token: issued.refreshToken,
        });
      }
      return fail("unsupported_grant_type", "authorization_code or refresh_token");
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, listenHost);
  await once(server, "listening");
  issuer = `http://${urlHost}:${(server.address() as AddressInfo).port}`;

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      server.closeAllConnections();
      server.close();
      await Promise.all([once(server, "close"), mcp.close()]);
    })();
    return closing;
  };

  return {
    mcp,
    issuer,
    registrations,
    authorizations,
    tokenRequests,
    setTokenLifetime(seconds) {
      lifetime = seconds;
    },
    setIss(iss) {
      issOverride = iss;
    },
    setDenying(deny) {
      denying = deny;
    },
    grant(grantOptions = {}) {
      const clientId = grantOptions.clientId ?? "fixture-client";
      const before = lifetime;
      if (grantOptions.lifetimeSeconds !== undefined) lifetime = grantOptions.lifetimeSeconds;
      const issued = issue({ clientId, resource, scope: undefined });
      lifetime = before;
      return { ...issued, clientId };
    },
    revoke() {
      accessTokens.clear();
      refreshTokens.clear();
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
