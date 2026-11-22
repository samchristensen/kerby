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

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

async function readCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes)
    throw new HttpError(413, "too_large", `request body is limited to ${maxBytes} bytes`);
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", `request body is limited to ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a JSON request body at the boundary, capped at `maxBytes` (default 1 MiB): a bad body is a 400 naming the
 * offending keys and never echoing values; an oversized one is a 413.
 */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  options: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const text = await readCapped(request, options.maxBytes ?? DEFAULT_MAX_BODY_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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
/** The peer of the TCP connection: behind a proxy, that is the proxy (see the api's `TRUST_PROXY`). */
export type Client = { address: string };
export type RouteHandler = (
  request: Request,
  params: Params,
  client: Client,
) => Promise<Response> | Response;
export type Route = readonly [method: string, pattern: string, handler: RouteHandler];
export type FetchHandler = (request: Request, client: Client) => Promise<Response>;

type Compiled = { method: string; segments: string[]; handler: RouteHandler };

/** `/v1/things/:id` style patterns; the first route that matches wins; a path match with another method is 405. */
export function createRouter(routes: readonly Route[]): FetchHandler {
  const compiled: Compiled[] = routes.map(([method, pattern, handler]) => ({
    method,
    segments: pattern.split("/").filter(Boolean),
    handler,
  }));
  return async (request, client) => {
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
        return await route.handler(request, params, client);
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

/**
 * The Fetch `Request` for a Node request. The URL's host is fixed: nothing here routes by Host, and a hostile Host
 * header must not be able to make the URL invalid. Throws for what the Fetch standard cannot represent (a TRACE
 * method, a request target that is not a path); the caller answers those with a status, never an exception.
 */
function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
  const target = incoming.url ?? "/";
  if (!target.startsWith("/")) throw new RangeError("the request target must be a path");
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  return new Request(`http://localhost${target}`, {
    method: incoming.method ?? "GET",
    headers,
    signal,
    ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
  });
}

/** Resolves when the response drained or the client went away, whichever comes first. */
function drained(outgoing: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      outgoing.off("drain", done);
      outgoing.off("close", done);
      resolve();
    };
    outgoing.once("drain", done);
    outgoing.once("close", done);
  });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  // A stream may take a while to produce its first chunk: let the client see the status and headers now.
  outgoing.flushHeaders();
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Honour backpressure: a slow client must not make us buffer a stream without bound. A client that left
      // while we waited never drains: stop, so the stream's resources (a database connection) are released.
      if (!outgoing.write(value)) await drained(outgoing);
      if (outgoing.destroyed) {
        await reader.cancel().catch(() => {});
        return;
      }
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
    // A Request's `signal` follows `aborted` only while the Request is reachable (undici links them through a WeakRef).
    // A streaming handler often keeps only a listener on that signal, so hold the Request until the exchange ends.
    let request: Request | undefined;
    outgoing.on("close", () => {
      aborted.abort();
      request = undefined;
    });
    Promise.resolve()
      .then(() => {
        try {
          request = toRequest(incoming, aborted.signal);
          return handler(request, { address: incoming.socket.remoteAddress ?? "" });
        } catch {
          // A request Fetch cannot represent: refuse it, and stay up.
          return json(400, { error: { code: "invalid_request", message: "unsupported request" } });
        }
      })
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
