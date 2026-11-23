// A real MCP server on node:http for tests, in either era: `stateless` (2026-07-28: every request carries its version,
// no initialize, no session) or `session` (2025-11-25: initialize, Mcp-Session-Id, DELETE). Not for production.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { McpContent } from "./index.ts";
import {
  decodeHeaderValue,
  HEADER_MISMATCH,
  isRecord,
  LEGACY_VERSIONS,
  MCP_CALL_ID_META_KEY,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  MODERN_VERSION,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./protocol.ts";

type FixtureToolResult = { content: McpContent[]; structuredContent?: unknown; isError?: boolean };

type FixtureToolContext = {
  /** The call's `params._meta`. */
  meta: Record<string, unknown>;
  /** Aborted when the client closes the connection before the answer is sent. */
  signal: AbortSignal;
  /** Sends a notification on the call's event stream (SSE only; dropped for JSON). */
  notify(method: string, params?: Record<string, unknown>): void;
  /**
   * Sends a server request on the call's event stream. In `session` mode with SSE it resolves with the client's
   * JSON-RPC response to it; otherwise (no way to reply) it resolves undefined at once.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

type FixtureTool = {
  name: string;
  title?: string;
  description?: string;
  /** Default `{ type: "object" }`. */
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Default: a text content of the arguments as JSON. A throw becomes JSON-RPC error -32603 with its message. */
  handler?: (
    args: Record<string, unknown>,
    context: FixtureToolContext,
  ) => FixtureToolResult | Promise<FixtureToolResult>;
};

type FixtureRequest = {
  httpMethod: string;
  /** The JSON-RPC method; undefined for a client's response to a server request, or a non-POST. */
  method: string | undefined;
  id: string | number | undefined;
  params: Record<string, unknown> | undefined;
  /** The client's response to a server request, as received. */
  message: Record<string, unknown> | undefined;
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  headers: IncomingHttpHeaders;
};

type FixtureCall = {
  name: string;
  arguments: Record<string, unknown>;
  callId: unknown;
  meta: Record<string, unknown>;
  sessionId: string | undefined;
};

export type McpFixture = AsyncDisposable & {
  /** The MCP endpoint, `http://127.0.0.1:<port>/mcp`. */
  url: string;
  /** Every HTTP request, in arrival order. */
  requests: FixtureRequest[];
  /** Every `tools/call` that reached a tool. */
  calls: FixtureCall[];
  /** Live handshake sessions (session mode). */
  sessions(): string[];
  /** Replaces the tools listed and callable from the next request on. */
  setTools(tools: FixtureTool[]): void;
  /** Forgets every session: the next request with an old Mcp-Session-Id gets 404 (session mode). */
  dropSessions(): void;
  close(): Promise<void>;
};

type RpcReply =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown }; status?: number };

type Session = { pending: Map<string, (message: Record<string, unknown>) => void> };

/** One event stream or one JSON body for one request's answer. */
type Channel = {
  sse: boolean;
  send(message: Record<string, unknown>): void;
  finish(message: Record<string, unknown>): void;
};

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export type McpFixtureOptions = {
  mode: "stateless" | "session";
  /** How requests are answered: one JSON object (default) or an event stream. */
  encoding?: "json" | "sse";
  tools?: FixtureTool[];
  /** Tools per `tools/list` page; default all on one page. */
  pageSize?: number;
  /** Every request without this exact header value gets 401. */
  requiredHeader?: { name: string; value: string };
};

/** Starts the fixture on an ephemeral loopback port. */
export async function startMcpFixture(options: McpFixtureOptions): Promise<McpFixture> {
  const { mode, requiredHeader } = options;
  const sse = options.encoding === "sse";
  let tools = options.tools ?? [];
  const requests: FixtureRequest[] = [];
  const calls: FixtureCall[] = [];
  const sessions = new Map<string, Session>();
  let serverRequestId = 0;
  let eventId = 0;

  const json = (
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };
  const rpcError = (
    res: ServerResponse,
    status: number,
    id: unknown,
    code: number,
    message: string,
    data?: unknown,
  ) =>
    json(res, status, {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });

  const channelFor = (res: ServerResponse, extra: Record<string, string>): Channel => {
    if (!sse) {
      return {
        sse: false,
        send() {},
        finish(message) {
          json(res, 200, message, extra);
        },
      };
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...extra,
    });
    // A 2025-11-25 server primes the stream with an event id and empty data.
    if (mode === "session") res.write(`id: ${++eventId}\ndata:\n\n`);
    const write = (message: Record<string, unknown>) => {
      const id = mode === "session" ? `id: ${++eventId}\n` : "";
      res.write(`${id}event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };
    return {
      sse: true,
      send: write,
      finish(message) {
        write(message);
        res.end();
      },
    };
  };

  async function callTool(
    params: Record<string, unknown>,
    channel: Channel,
    signal: AbortSignal,
    session: Session | undefined,
    sessionId: string | undefined,
  ): Promise<RpcReply> {
    const name = params.name;
    const tool = tools.find((candidate) => candidate.name === name);
    if (typeof name !== "string" || !tool) {
      return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    calls.push({ name, arguments: args, callId: meta[MCP_CALL_ID_META_KEY], meta, sessionId });
    const context: FixtureToolContext = {
      meta,
      signal,
      notify(method, notifyParams) {
        channel.send({ jsonrpc: "2.0", method, ...(notifyParams ? { params: notifyParams } : {}) });
      },
      request(method, requestParams) {
        if (!channel.sse) return Promise.resolve(undefined);
        const id = `server-${++serverRequestId}`;
        const reply = Promise.withResolvers<unknown>();
        if (session) session.pending.set(id, reply.resolve);
        else reply.resolve(undefined);
        channel.send({
          jsonrpc: "2.0",
          id,
          method,
          ...(requestParams ? { params: requestParams } : {}),
        });
        return reply.promise;
      },
    };
    try {
      const handler =
        tool.handler ??
        ((input: Record<string, unknown>) => ({
          content: [{ type: "text", text: JSON.stringify(input) }],
        }));
      const outcome = await handler(args, context);
      return { result: { ...outcome } };
    } catch (error) {
      return {
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  function listTools(params: Record<string, unknown>): RpcReply {
    const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
    if (!Number.isInteger(start) || start < 0)
      return { error: { code: -32602, message: "Invalid cursor" } };
    const size = options.pageSize ?? Math.max(tools.length, 1);
    const page = tools.slice(start, start + size).map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: tool.inputSchema ?? { type: "object" },
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }));
    const next = start + size < tools.length ? { nextCursor: String(start + size) } : {};
    return { result: { tools: page, ...next } };
  }

  async function answer(
    res: ServerResponse,
    id: string | number,
    method: string,
    params: Record<string, unknown>,
    extra: Record<string, string>,
    session: Session | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort(new Error("the client went away"));
    });
    if (method !== "tools/list" && method !== "tools/call") {
      const status = mode === "stateless" ? 404 : 200;
      return rpcError(res, status, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
    if (method === "tools/list") {
      const reply = listTools(params);
      if ("error" in reply) return rpcError(res, 400, id, reply.error.code, reply.error.message);
      const channel = channelFor(res, extra);
      return channel.finish(finalMessage(id, reply));
    }
    const channel = channelFor(res, extra);
    const reply = await callTool(params, channel, controller.signal, session, sessionId);
    if (controller.signal.aborted) return;
    channel.finish(finalMessage(id, reply));
  }

  function finalMessage(id: string | number, reply: RpcReply): Record<string, unknown> {
    if ("error" in reply) return { jsonrpc: "2.0", id, error: reply.error };
    const result =
      mode === "stateless" ? { resultType: "complete", ...reply.result } : reply.result;
    return { jsonrpc: "2.0", id, result };
  }

  async function onStateless(
    req: IncomingMessage,
    res: ServerResponse,
    message: Record<string, unknown>,
  ) {
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    if (typeof method !== "string" || id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return rpcError(res, 400, null, -32600, "Invalid request id");
    }
    if (method === "initialize") {
      return rpcError(res, 400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: [MODERN_VERSION],
        requested: params.protocolVersion,
      });
    }
    const meta = isRecord(params._meta) ? params._meta : {};
    const version = meta[META_PROTOCOL_VERSION];
    if (typeof version !== "string" || !isRecord(meta[META_CLIENT_CAPABILITIES])) {
      return rpcError(
        res,
        400,
        id,
        -32602,
        "Invalid params: _meta lacks the protocol version or client capabilities",
      );
    }
    if (header(req, "mcp-protocol-version") !== version) {
      return rpcError(res, 400, id, HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version");
    }
    if (version !== MODERN_VERSION) {
      return rpcError(res, 400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
        supported: [MODERN_VERSION],
        requested: version,
      });
    }
    if (header(req, "mcp-method") !== method) {
      return rpcError(res, 400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Method");
    }
    const name = header(req, "mcp-name");
    if (
      method === "tools/call" &&
      (name === undefined || decodeHeaderValue(name) !== params.name)
    ) {
      return rpcError(res, 400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Name");
    }
    await answer(res, id, method, params, {}, undefined, undefined);
  }

  async function onSession(
    req: IncomingMessage,
    res: ServerResponse,
    message: Record<string, unknown>,
  ) {
    const { id, method } = message;
    const params = isRecord(message.params) ? message.params : {};
    if (method === "initialize") {
      if (typeof id !== "string" && typeof id !== "number")
        return rpcError(res, 400, null, -32600, "Invalid request id");
      const requested = params.protocolVersion;
      const version =
        typeof requested === "string" && LEGACY_VERSIONS.includes(requested)
          ? requested
          : LEGACY_VERSIONS[0];
      const sessionId = randomUUID();
      sessions.set(sessionId, { pending: new Map() });
      const channel = channelFor(res, { "mcp-session-id": sessionId });
      return channel.finish({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "kerby-mcp-fixture", version: "1.0.0" },
        },
      });
    }
    const sessionId = header(req, "mcp-session-id");
    if (sessionId === undefined) {
      return rpcError(res, 400, null, -32000, "Bad Request: Mcp-Session-Id header is required");
    }
    const session = sessions.get(sessionId);
    if (!session) return rpcError(res, 404, null, -32001, "Session not found");
    const version = header(req, "mcp-protocol-version");
    if (version !== undefined && !LEGACY_VERSIONS.includes(version)) {
      return rpcError(
        res,
        400,
        null,
        -32000,
        `Bad Request: Unsupported protocol version ${version}`,
      );
    }
    if (typeof method !== "string") {
      // The client's response to a server request.
      const resolve = session.pending.get(String(id));
      session.pending.delete(String(id));
      resolve?.(message);
      res.writeHead(202).end();
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      res.writeHead(202).end();
      return;
    }
    await answer(res, id, method, params, {}, session, sessionId);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const record: FixtureRequest = {
      httpMethod: req.method ?? "",
      method: undefined,
      id: undefined,
      params: undefined,
      message: undefined,
      sessionId: header(req, "mcp-session-id"),
      protocolVersion: header(req, "mcp-protocol-version"),
      headers: req.headers,
    };
    requests.push(record);
    if (requiredHeader && header(req, requiredHeader.name.toLowerCase()) !== requiredHeader.value) {
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized");
      return;
    }
    if (req.method === "DELETE" && mode === "session") {
      const sessionId = record.sessionId;
      if (sessionId === undefined || !sessions.delete(sessionId)) res.writeHead(404).end();
      else res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return rpcError(res, 400, null, -32700, "Parse error");
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return rpcError(res, 400, null, -32600, "Invalid Request");
    }
    const { id, method, params } = message;
    record.method = typeof method === "string" ? method : undefined;
    record.id = typeof id === "string" || typeof id === "number" ? id : undefined;
    record.params = isRecord(params) ? params : undefined;
    if (typeof method !== "string") record.message = message;
    if (mode === "stateless") await onStateless(req, res, message);
    else await onSession(req, res, message);
  }

  const server = createServer((req, res) => {
    res.on("error", () => {});
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    })();
    return closing;
  };

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    calls,
    sessions: () => [...sessions.keys()],
    setTools(next) {
      tools = next;
    },
    dropSessions() {
      sessions.clear();
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
