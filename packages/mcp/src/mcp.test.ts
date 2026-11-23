import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createEgressFetch } from "@kerby/egress";
import { afterEach, describe, expect, it } from "vitest";
import { McpError, type McpSession, openMcpSession } from "./index.ts";
import { type McpFixture, type McpFixtureOptions, startMcpFixture } from "./testing.ts";

const clientInfo = { name: "kerby-test", version: "0.0.0" };
const signal = () => AbortSignal.timeout(10_000);
const SECRET = "Bearer s3cret-token-value";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: McpFixtureOptions): Promise<McpFixture> {
  const started = await startMcpFixture(options);
  cleanups.push(() => started.close());
  return started;
}

function session(url: string, headers?: Record<string, string>): McpSession {
  const opened = openMcpSession({ url, fetch, clientInfo, ...(headers ? { headers } : {}) });
  cleanups.push(() => opened.close());
  return opened;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

async function mcpRejection(promise: Promise<unknown>): Promise<McpError> {
  const error = await rejection(promise);
  if (!(error instanceof McpError)) throw new Error(`expected an McpError, got ${String(error)}`);
  return error;
}

const weather = {
  name: "get_weather",
  title: "Weather",
  description: "Current weather for a city",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  annotations: { readOnlyHint: true },
};

describe.each([
  { mode: "stateless", encoding: "json" },
  { mode: "stateless", encoding: "sse" },
  { mode: "session", encoding: "json" },
  { mode: "session", encoding: "sse" },
] as const)("$mode server answering $encoding", ({ mode, encoding }) => {
  const base = { mode, encoding } as const;

  it("lists every tool across pages, in order, keeping title and annotations", async () => {
    const tools = [weather, ...["a", "b", "c", "d"].map((name) => ({ name }))];
    const server = await fixture({ ...base, tools, pageSize: 2 });
    const listed = await session(server.url).listTools(signal());
    expect(listed).toEqual([
      {
        name: "get_weather",
        title: "Weather",
        description: "Current weather for a city",
        inputSchema: weather.inputSchema,
        annotations: { readOnlyHint: true },
      },
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
      { name: "c", description: "", inputSchema: { type: "object" } },
      { name: "d", description: "", inputSchema: { type: "object" } },
    ]);
    const cursors = server.requests
      // In session mode the first, 2026-07-28 attempt has no session and is refused.
      .filter((request) => request.method === "tools/list")
      .filter((request) => mode === "stateless" || request.sessionId !== undefined)
      .map((request) => request.params?.cursor);
    expect(cursors).toEqual([undefined, "2", "4"]);
  });

  it("calls tools: text, structured content, and a tool error", async () => {
    const server = await fixture({
      ...base,
      tools: [
        { name: "echo" },
        {
          name: "measure",
          handler: () => ({
            content: [{ type: "text", text: '{"celsius":21}' }],
            structuredContent: { celsius: 21 },
          }),
        },
        {
          name: "fails",
          handler: () => ({ content: [{ type: "text", text: "no such city" }], isError: true }),
        },
      ],
    });
    const client = session(server.url);
    expect(
      await client.callTool("echo", { city: "Oslo" }, { callId: "c1", signal: signal() }),
    ).toEqual({
      content: [{ type: "text", text: '{"city":"Oslo"}' }],
      isError: false,
    });
    expect(await client.callTool("measure", {}, { callId: "c2", signal: signal() })).toEqual({
      content: [{ type: "text", text: '{"celsius":21}' }],
      structuredContent: { celsius: 21 },
      isError: false,
    });
    expect(await client.callTool("fails", {}, { callId: "c3", signal: signal() })).toEqual({
      content: [{ type: "text", text: "no such city" }],
      isError: true,
    });
    expect(server.calls.map((call) => [call.name, call.callId])).toEqual([
      ["echo", "c1"],
      ["measure", "c2"],
      ["fails", "c3"],
    ]);
  });

  it("reports a JSON-RPC error as rpc, keeping its code and message", async () => {
    const server = await fixture({ ...base, tools: [{ name: "echo" }] });
    const error = await mcpRejection(
      session(server.url).callTool("missing", {}, { callId: "c1", signal: signal() }),
    );
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ kind: "rpc", code: -32602 });
    expect(error.message).toContain("Unknown tool: missing");
  });

  it("refuses a wrong credential as unauthorized without echoing it", async () => {
    const server = await fixture({
      ...base,
      requiredHeader: { name: "Authorization", value: "Bearer right" },
    });
    const error = await mcpRejection(
      session(server.url, { Authorization: SECRET }).listTools(signal()),
    );
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(error.message).not.toContain("s3cret");
    // With the right one, the same server answers.
    expect(
      await session(server.url, { Authorization: "Bearer right" }).listTools(signal()),
    ).toEqual([]);
  });

  it("does not hang on a server request sent on the call's stream", async () => {
    const server = await fixture({
      ...base,
      tools: [
        {
          name: "asks",
          handler: async (_args, context) => {
            context.notify("notifications/progress", { progress: 1, progressToken: "p" });
            const reply = await context.request("sampling/createMessage", { messages: [] });
            return { content: [{ type: "text", text: JSON.stringify(reply ?? null) }] };
          },
        },
      ],
    });
    const outcome = await session(server.url).callTool(
      "asks",
      {},
      { callId: "c1", signal: signal() },
    );
    const replies = server.requests.filter((request) => request.message !== undefined);
    if (mode === "session" && encoding === "sse") {
      // A handshake session can answer: Kerby refuses (no sampling, no client capabilities).
      const first = outcome.content[0];
      const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
      const reply = JSON.parse(text);
      expect(reply).toMatchObject({ id: "server-1", error: { code: -32601 } });
      expect(replies).toHaveLength(1);
    } else {
      // 2026-07-28 has no way to reply (and JSON has no stream): the request is ignored.
      expect(outcome.content).toEqual([{ type: "text", text: "null" }]);
      expect(replies).toHaveLength(0);
    }
  });

  it("stops a call when its signal aborts", async () => {
    const gone = Promise.withResolvers<void>();
    const server = await fixture({
      ...base,
      tools: [
        {
          name: "slow",
          handler: async (_args, context) => {
            context.signal.addEventListener("abort", () => gone.resolve());
            await new Promise(() => {});
            return { content: [] };
          },
        },
      ],
    });
    const client = session(server.url);
    const controller = new AbortController();
    const call = client.callTool("slow", {}, { callId: "c1", signal: controller.signal });
    await expect.poll(() => server.calls.length).toBe(1);
    controller.abort(new Error("turn cancelled"));
    expect(await rejection(call)).toMatchObject({ message: "turn cancelled" });
    await gone.promise;
    await client.close();
    if (mode === "session") {
      // A handshake server is also told, since a closed connection is not a cancellation there.
      const cancelled = server.requests.find(
        (request) => request.method === "notifications/cancelled",
      );
      expect(cancelled?.params).toMatchObject({ requestId: expect.any(Number) });
    }
  });

  it("sees a changed listing on the next call", async () => {
    const server = await fixture({ ...base, tools: [{ name: "one" }] });
    const client = session(server.url);
    expect((await client.listTools(signal())).map((tool) => tool.name)).toEqual(["one"]);
    server.setTools([{ name: "two" }, { name: "three" }]);
    expect((await client.listTools(signal())).map((tool) => tool.name)).toEqual(["two", "three"]);
  });
});

describe("a 2026-07-28 server", () => {
  it("gets the version, client info and no capabilities on every request, and no session", async () => {
    const server = await fixture({ mode: "stateless", tools: [{ name: "echo" }] });
    const client = session(server.url);
    await client.listTools(signal());
    await client.callTool("echo", {}, { callId: "c1", signal: signal() });
    await client.close();
    expect(server.requests.map((request) => [request.httpMethod, request.method])).toEqual([
      ["POST", "tools/list"],
      ["POST", "tools/call"],
    ]);
    for (const request of server.requests) {
      expect(request.protocolVersion).toBe("2026-07-28");
      expect(request.headers["mcp-method"]).toBe(request.method);
      expect(request.params?._meta).toMatchObject({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": clientInfo,
        "io.modelcontextprotocol/clientCapabilities": {},
      });
    }
    expect(server.requests[1]?.headers["mcp-name"]).toBe("echo");
    expect(server.calls[0]?.meta).toMatchObject({ "kerby/callId": "c1" });
  });

  it("mirrors x-mcp-header arguments into headers and drops tools whose annotations are invalid", async () => {
    const sql = {
      name: "execute_sql",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
      },
    };
    const broken = {
      name: "broken",
      inputSchema: {
        type: "object",
        properties: { rows: { type: "array", items: { type: "string", "x-mcp-header": "Row" } } },
      },
    };
    const server = await fixture({ mode: "stateless", tools: [sql, broken] });
    const client = session(server.url);
    const listed = await client.listTools(signal());
    expect(listed.map((tool) => tool.name)).toEqual(["execute_sql"]);
    await client.callTool(
      "execute_sql",
      { region: "Zürich", query: "select 1" },
      { callId: "c1", signal: signal(), inputSchema: sql.inputSchema },
    );
    const call = server.requests.find((request) => request.method === "tools/call");
    expect(call?.headers["mcp-param-region"]).toBe(
      `=?base64?${Buffer.from("Zürich").toString("base64")}?=`,
    );
  });

  it("stops listing after 50 pages", async () => {
    const tools = Array.from({ length: 51 }, (_, index) => ({ name: `t${index}` }));
    const server = await fixture({ mode: "stateless", tools, pageSize: 1 });
    const error = await mcpRejection(session(server.url).listTools(signal()));
    expect(error).toMatchObject({ kind: "protocol" });
    expect(error.message).toContain("50 pages");
  });
});

describe("a 2025-11-25 server", () => {
  it("falls back to initialize once, reuses the session id and DELETEs it on close", async () => {
    const server = await fixture({ mode: "session", tools: [{ name: "echo" }] });
    const client = session(server.url);
    await client.listTools(signal());
    await client.callTool("echo", {}, { callId: "c1", signal: signal() });
    await client.callTool("echo", {}, { callId: "c2", signal: signal() });
    const [sessionId] = server.sessions();
    expect(sessionId).toBeDefined();
    await client.close();
    expect(server.requests.map((request) => [request.httpMethod, request.method ?? null])).toEqual([
      ["POST", "tools/list"], // the 2026-07-28 attempt, refused with 400
      ["POST", "initialize"],
      ["POST", "notifications/initialized"],
      ["POST", "tools/list"],
      ["POST", "tools/call"],
      ["POST", "tools/call"],
      ["DELETE", null],
    ]);
    const initialize = server.requests[1];
    expect(initialize?.params).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo,
    });
    for (const request of server.requests.slice(2)) {
      expect(request.sessionId).toBe(sessionId);
      expect(request.protocolVersion).toBe("2025-11-25");
    }
    expect(server.sessions()).toEqual([]);
    expect(server.calls.map((call) => call.callId)).toEqual(["c1", "c2"]);
  });

  it("starts a new session when the server forgot the old one", async () => {
    const server = await fixture({ mode: "session", tools: [{ name: "echo" }] });
    const client = session(server.url);
    await client.callTool("echo", {}, { callId: "c1", signal: signal() });
    const [first] = server.sessions();
    server.dropSessions();
    await client.callTool("echo", {}, { callId: "c2", signal: signal() });
    const [second] = server.sessions();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(server.calls.map((call) => [call.callId, call.sessionId])).toEqual([
      ["c1", first],
      ["c2", second],
    ]);
  });
});

describe("through the egress guard", () => {
  it("lists and calls over createEgressFetch", async () => {
    const server = await fixture({ mode: "session", encoding: "sse", tools: [weather] });
    const client = openMcpSession({
      url: server.url,
      fetch: createEgressFetch({ blockedRanges: [] }),
      clientInfo,
    });
    cleanups.push(() => client.close());
    expect((await client.listTools(signal())).map((tool) => tool.name)).toEqual(["get_weather"]);
    const outcome = await client.callTool(
      "get_weather",
      { city: "Oslo" },
      { callId: "c1", signal: signal() },
    );
    expect(outcome).toEqual({
      content: [{ type: "text", text: '{"city":"Oslo"}' }],
      isError: false,
    });
  });

  it("is refused by the default guard on loopback", async () => {
    const server = await fixture({ mode: "stateless" });
    const client = session(server.url);
    const guarded = openMcpSession({ url: server.url, fetch: createEgressFetch(), clientInfo });
    expect(await rejection(guarded.listTools(signal()))).toMatchObject({ name: "EgressError" });
    expect(await client.listTools(signal())).toEqual([]);
  });
});

describe("a misbehaving server", () => {
  let raw: Server;
  async function serve(route: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
    raw = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      route(req, res, Buffer.concat(chunks).toString());
    });
    raw.listen(0, "127.0.0.1");
    await once(raw, "listening");
    cleanups.push(async () => {
      raw.closeAllConnections();
      raw.close();
    });
    return `http://127.0.0.1:${(raw.address() as AddressInfo).port}/mcp`;
  }
  const idOf = (body: string): unknown => JSON.parse(body).id;

  it("answering another id is a protocol error", async () => {
    const url = await serve((_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: Number(idOf(body)) + 7, result: { tools: [] } }),
      );
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error).toMatchObject({ kind: "protocol" });
    expect(error.message).toContain("request id");
  });

  it("answering with something other than JSON is a protocol error", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>hello</html>");
    });
    expect(await rejection(session(url).listTools(signal()))).toMatchObject({ kind: "protocol" });
  });

  it("a malformed tools/list result is a protocol error naming the field", async () => {
    const url = await serve((_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: idOf(body), result: { tools: [{ name: 3 }] } }));
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error).toMatchObject({ kind: "protocol" });
    expect(error.message).toContain("tools.0.name");
  });

  it("an oversized event is a protocol error", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = "x".repeat(64 * 1024);
      res.write("data: ");
      for (let sent = 0; sent < 5 * 1024 * 1024; sent += chunk.length) res.write(chunk);
      res.end("\n\n");
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error).toMatchObject({ kind: "protocol" });
    expect(error.message).toContain("server-sent event over");
  });

  it("an event stream that ends without the answer is a protocol error", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(': keep-alive\n\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\n\n');
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error.message).toContain("ended before answering");
  });

  it("a server error status is http, without echoing the credential", async () => {
    const url = await serve((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`broken; you sent ${req.headers["x-api-key"]}`);
    });
    const error = await mcpRejection(session(url, { "X-Api-Key": SECRET }).listTools(signal()));
    expect(error).toMatchObject({ kind: "http", status: 500 });
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("s3cret");
  });

  it("a 403 is unauthorized", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(403).end();
    });
    expect(await rejection(session(url).listTools(signal()))).toMatchObject({
      kind: "unauthorized",
      status: 403,
    });
  });

  it("asking for client input is a protocol error: Kerby declares no capabilities", async () => {
    const url = await serve((_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: idOf(body),
          result: { resultType: "input_required", inputRequests: {} },
        }),
      );
    });
    const error = await mcpRejection(
      session(url).callTool("t", {}, { callId: "c", signal: signal() }),
    );
    expect(error).toMatchObject({ kind: "protocol" });
    expect(error.message).toContain("no client capabilities");
  });

  it("an unsupported version without a handshake version Kerby speaks names the server's versions", async () => {
    const url = await serve((_req, res, body) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: idOf(body),
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported: ["2027-01-01"], requested: "2026-07-28" },
          },
        }),
      );
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error).toMatchObject({ kind: "rpc", code: -32022, status: 400 });
    expect(error.message).toContain("2027-01-01");
  });

  it("a server that refuses both eras says so", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" }).end("nope");
    });
    const error = await mcpRejection(session(url).listTools(signal()));
    expect(error).toMatchObject({ kind: "http", status: 400 });
    expect(error.message).toContain("neither 2026-07-28 (HTTP 400) nor initialize");
  });
});
