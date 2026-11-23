import { createEgressFetch } from "@kerby/egress";
import { describe, expect, it } from "vitest";
import {
  authorizationUrl,
  createPkce,
  discoverOAuth,
  exchangeOAuthCode,
  issuerProblem,
  OAuthError,
  openMcpSession,
  refreshOAuthCredential,
  registerOAuthClient,
} from "./index.ts";
import { startOAuthFixture } from "./testing.ts";

// The egress guard as the services build it, letting the loopback fixture through.
const fetch = createEgressFetch({ blockedRanges: [] });
const loopback = (url: URL) => url.hostname === "127.0.0.1";
const REDIRECT = "https://console.example/dashboard/tools/oauth/callback";

/** Follow an authorization URL like a browser that approves at once, and read the redirect back. */
async function approve(url: string): Promise<URLSearchParams> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error(`no redirect: ${response.status}`);
  const back = new URL(location);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return back.searchParams;
}

describe("OAuth (MCP authorization)", () => {
  it.each(["challenge", "path", "root"] as const)(
    "discovers, registers, authorizes, exchanges and refreshes (metadata at %s)",
    async (metadataAt) => {
      await using server = await startOAuthFixture({
        metadataAt,
        challengeScope: "tools:read",
        tools: [{ name: "search" }],
      });
      const discovery = await discoverOAuth({ url: server.mcp.url, fetch, insecure: loopback });
      expect(discovery).toMatchObject({
        resource: server.mcp.url,
        issuer: server.issuer,
        tokenEndpoint: `${server.issuer}/token`,
        clientIdMetadataDocuments: false,
        issParameterSupported: true,
        scope: "tools:read",
      });
      if (!discovery.registrationEndpoint) throw new Error("no registration endpoint");
      const client = await registerOAuthClient({
        fetch,
        registrationEndpoint: discovery.registrationEndpoint,
        redirectUri: REDIRECT,
      });
      expect(client.clientAuth).toBe("none");
      expect(server.registrations[0]).toMatchObject({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        application_type: "web",
      });

      const pkce = createPkce();
      const answer = await approve(
        authorizationUrl({
          authorizationEndpoint: discovery.authorizationEndpoint,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeChallenge: pkce.challenge,
          state: "the-state",
          resource: discovery.resource,
          scope: discovery.scope,
        }),
      );
      expect(answer.get("state")).toBe("the-state");
      expect(issuerProblem(discovery.issuer, true, answer.get("iss") ?? undefined)).toBeUndefined();
      const sent = server.authorizations[0];
      expect(sent?.get("code_challenge_method")).toBe("S256");
      expect(sent?.get("resource")).toBe(server.mcp.url);
      expect(sent?.get("scope")).toBe("tools:read");

      const tokenClient = {
        tokenEndpoint: discovery.tokenEndpoint,
        issuer: discovery.issuer,
        clientId: client.clientId,
        clientAuth: client.clientAuth,
        resource: discovery.resource,
      };
      // A wrong verifier is refused: PKCE binds the code to whoever began the flow.
      const stolen = await approve(
        authorizationUrl({
          authorizationEndpoint: discovery.authorizationEndpoint,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeChallenge: pkce.challenge,
          state: "s2",
          resource: discovery.resource,
          scope: undefined,
        }),
      );
      const refused = await exchangeOAuthCode({
        fetch,
        client: tokenClient,
        code: stolen.get("code") ?? "",
        codeVerifier: createPkce().verifier,
        redirectUri: REDIRECT,
      }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(OAuthError);
      expect((refused as OAuthError).code).toBe("invalid_grant");

      const credential = await exchangeOAuthCode({
        fetch,
        client: tokenClient,
        code: answer.get("code") ?? "",
        codeVerifier: pkce.verifier,
        redirectUri: REDIRECT,
      });
      expect(credential).toMatchObject({
        kind: "oauth",
        resource: server.mcp.url,
        scope: "tools:read",
      });
      expect(Date.parse(credential.expiresAt ?? "")).toBeGreaterThan(Date.now());
      expect(server.tokenRequests.at(-1)?.get("resource")).toBe(server.mcp.url);

      const session = openMcpSession({
        url: server.mcp.url,
        fetch,
        headers: { Authorization: `Bearer ${credential.accessToken}` },
        clientInfo: { name: "kerby-test", version: "0" },
      });
      expect((await session.listTools(AbortSignal.timeout(10_000))).map((t) => t.name)).toEqual([
        "search",
      ]);

      // Refresh rotates the refresh token; the spent one is refused.
      if (!credential.refreshToken) throw new Error("no refresh token");
      const refreshed = await refreshOAuthCredential({
        fetch,
        credential: { ...credential, refreshToken: credential.refreshToken },
      });
      expect(refreshed.refreshToken).not.toBe(credential.refreshToken);
      expect(refreshed.accessToken).not.toBe(credential.accessToken);
      const replayed = await refreshOAuthCredential({
        fetch,
        credential: { ...credential, refreshToken: credential.refreshToken },
      }).catch((error: unknown) => error);
      expect((replayed as OAuthError).code).toBe("invalid_grant");
    },
  );

  it("refuses an authorization server without PKCE S256, and plain http unless allowed", async () => {
    await using server = await startOAuthFixture({ pkce: false });
    await expect(discoverOAuth({ url: server.mcp.url, fetch, insecure: loopback })).rejects.toThrow(
      /does not support PKCE with S256/,
    );
    await expect(discoverOAuth({ url: server.mcp.url, fetch })).rejects.toThrow(/must use https/);
  });

  it("applies RFC 9207's issuer table", () => {
    const issuer = "https://auth.example";
    expect(issuerProblem(issuer, true, issuer)).toBeUndefined();
    expect(issuerProblem(issuer, true, undefined)).toMatch(/carries no iss/);
    expect(issuerProblem(issuer, false, undefined)).toBeUndefined();
    expect(issuerProblem(issuer, false, "https://evil.example")).toMatch(/mix-up/);
    // no normalization: a trailing slash is another issuer
    expect(issuerProblem(issuer, true, `${issuer}/`)).toMatch(/mix-up/);
  });
});
