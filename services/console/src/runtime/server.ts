// The console's HTTP server: Next.js behind a `node:http` server this process owns (ADR 0014). It answers `/healthz`
// and Kerby's OAuth Client ID Metadata Document itself, stamps each request with the client's address, and hands
// everything else to Next.js.
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { OAUTH_CLIENT_METADATA_PATH } from "@kerby/contracts";
import { errorFields, log } from "@kerby/observability";
import { clientAddress } from "@kerby/serve";
import next from "next";
import { CLIENT_ADDRESS_HEADER } from "../app/_lib/console.ts";

export type ConsoleServerOptions = {
  host: string;
  port: number;
  /** The workspace directory: Next.js reads `src/app` and the `.next` build from here. */
  dir: string;
  /** Next.js development mode: compiles on request and reloads; otherwise serves `next build`'s output. */
  dev: boolean;
  /** Take the client address from the left-most `X-Forwarded-For` entry (Railway's edge) instead of the socket. */
  trustProxy: boolean;
  /**
   * Kerby's Client ID Metadata Document (ADR 0022), served at `OAUTH_CLIENT_METADATA_PATH` to anyone: authorization
   * servers fetch it to learn Kerby's redirect URI. Undefined without a public URL: not served.
   */
  clientMetadata: Record<string, unknown> | undefined;
};

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function startServer(
  options: ConsoleServerOptions,
): Promise<{ port: number; close(): Promise<void> }> {
  const app = next({
    dev: options.dev,
    dir: options.dir,
    hostname: options.host,
    port: options.port,
  });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (
      options.clientMetadata &&
      (request.method === "GET" || request.method === "HEAD") &&
      request.url?.split("?")[0] === OAUTH_CLIENT_METADATA_PATH
    ) {
      response
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=3600",
        })
        .end(request.method === "HEAD" ? undefined : JSON.stringify(options.clientMetadata));
      return;
    }
    request.headers[CLIENT_ADDRESS_HEADER] = clientAddress(
      header(request, "x-forwarded-for"),
      request.socket.remoteAddress ?? "",
      options.trustProxy,
    );
    handle(request, response).catch((error: unknown) => {
      log("error", "request failed", { method: request.method, ...errorFields(error) });
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  // Development reloads over a WebSocket.
  if (options.dev) server.on("upgrade", app.getUpgradeHandler());
  server.listen(options.port, options.host);
  await once(server, "listening");
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : options.port,
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await app.close();
    },
  };
}
