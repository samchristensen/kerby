// A small HTTP layer over `node:http` with web-standard `Request`/`Response` (ADR 0005: no framework).
// A route is `(request, params) => Response`; errors thrown as `HttpError` become JSON error bodies; the
// request's `signal` aborts when the client goes away, so a streaming handler can stop.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";
import { errorFields, log } from "@kerby/observability";
import type { z } from "zod";

export class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Parse a JSON request body at the boundary: a bad body is a 400 naming the offending keys, never echoing values. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const keys = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`,
    );
    throw new HttpError(400, "invalid_request", keys.join("; "));
  }
  return parsed.data;
}

/** `Authorization: Bearer <token>`. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}

export type Params = Record<string, string>;
export type RouteHandler = (request: Request, params: Params) => Promise<Response> | Response;
export type Route = readonly [method: string, pattern: string, handler: RouteHandler];
export type FetchHandler = (request: Request) => Promise<Response>;

type Compiled = { method: string; segments: string[]; handler: RouteHandler };

/** `/v1/things/:id` style patterns; the first route that matches wins; a path match with another method is 405. */
export function createRouter(routes: readonly Route[]): FetchHandler {
  const compiled: Compiled[] = routes.map(([method, pattern, handler]) => ({
    method,
    segments: pattern.split("/").filter(Boolean),
    handler,
  }));
  return async (request) => {
    const path = new URL(request.url).pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of compiled) {
      if (route.segments.length !== path.length) continue;
      const params: Params = {};
      const matches = route.segments.every((segment, i) => {
        const part = path[i] ?? "";
        if (segment.startsWith(":")) {
          try {
            params[segment.slice(1)] = decodeURIComponent(part);
          } catch {
            return false;
          }
          return true;
        }
        return segment === part;
      });
      if (!matches) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;
      try {
        return await route.handler(request, params);
      } catch (error) {
        if (error instanceof HttpError) {
          return json(error.status, { error: { code: error.code, message: error.message } });
        }
        log("error", "unhandled error in route", { method: request.method, ...errorFields(error) });
        return json(500, { error: { code: "internal", message: "internal error" } });
      }
    }
    return pathMatched
      ? json(405, { error: { code: "method_not_allowed", message: "method not allowed" } })
      : json(404, { error: { code: "not_found", message: "not found" } });
  };
}

export type Server = { port: number; close(): Promise<void> };

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const host = incoming.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  return new Request(`http://${host}${incoming.url ?? "/"}`, {
    method: incoming.method ?? "GET",
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
  });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Honour backpressure: a slow client must not make us buffer a stream without bound.
      if (!outgoing.write(value))
        await new Promise<void>((resolve) => outgoing.once("drain", resolve));
    }
  } finally {
    outgoing.end();
  }
}

/** Listen on `port` (0 for any free port). */
export function serve(
  handler: FetchHandler,
  options: { host?: string; port: number },
): Promise<Server> {
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const aborted = new AbortController();
    outgoing.on("close", () => aborted.abort());
    handler(toRequest(incoming, aborted.signal))
      .then((response) => send(response, outgoing))
      .catch((error: unknown) => {
        log("error", "writing a response failed", errorFields(error));
        outgoing.destroy();
      });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const { promise, resolve, reject } = Promise.withResolvers<Server>();
  server.once("error", reject);
  server.listen(options.port, options.host ?? "0.0.0.0", () => {
    resolve({
      port: (server.address() as AddressInfo).port,
      close: () => {
        const closed = new Promise<void>((done) => server.close(() => done()));
        // Streams (SSE) never finish by themselves: end them so shutdown does not hang.
        for (const socket of sockets) socket.destroy();
        return closed;
      },
    });
  });
  return promise;
}
