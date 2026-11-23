// The console's HTTP server: Next.js behind a `node:http` server this process owns (ADR 0014). It answers `/healthz`
// itself, stamps each request with the client's address, and hands everything else to Next.js.
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
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
