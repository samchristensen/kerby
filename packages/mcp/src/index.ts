// An MCP client on a given `fetch` (ADR 0019): Streamable HTTP, stateless 2026-07-28 first, falling back to the
// handshake revisions (2025-11-25 and older). Kerby declares no client capabilities.
import { z } from "zod";
import { McpError } from "./errors.ts";
import {
  encodeHeaderValue,
  HEADER_MISMATCH,
  isRecord,
  LEGACY_VERSIONS,
  MCP_CALL_ID_META_KEY,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  MISSING_CLIENT_CAPABILITY,
  MODERN_VERSION,
  mcpHeaderParams,
  mcpParamHeaders,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./protocol.ts";
import { readSse } from "./sse.ts";

export { McpError } from "./errors.ts";

/** `tools/list` pages followed before giving up on a server that never stops paginating. */
const MAX_LIST_PAGES = 50;
/** One JSON response or one server-sent event, in characters. */
const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
/** What is read of an error response's body to find a JSON-RPC error in it. */
const MAX_ERROR_BODY_CHARS = 64 * 1024;
/** Statuses that, without a recognized 2026-07-28 error in the body, mean "a handshake server": fall back. */
const FALLBACK_STATUSES = new Set([400, 404, 405]);

/** @public The worker and the registry's sync read listings (ADR 0019). */
export type McpToolListing = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};
/** @public The worker turns content into what the model reads (ADR 0019). */
export type McpContent = { type: "text"; text: string } | { type: string; [key: string]: unknown };
/** @public The worker turns a call's outcome into a tool result (ADR 0019). */
export type McpCallOutcome = {
  content: McpContent[];
  structuredContent?: unknown;
  isError: boolean;
};

/** @public The worker holds one per server per run (ADR 0019). */
export interface McpSession {
  /** Every tool the server lists, following `nextCursor` for at most 50 pages. */
  listTools(signal: AbortSignal): Promise<McpToolListing[]>;
  /**
   * Calls a tool; `callId` goes in `params._meta["kerby/callId"]` for servers that deduplicate. `inputSchema` (the
   * definition the model saw) lets a 2026-07-28 server's `x-mcp-header` arguments be mirrored into `Mcp-Param-*`
   * headers. A tool that ran and failed is `isError: true`, not a throw.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: { callId: string; signal: AbortSignal; inputSchema?: Record<string, unknown> },
  ): Promise<McpCallOutcome>;
  /** Ends a handshake session (HTTP DELETE); nothing to do for a stateless server. Never throws. */
  close(): Promise<void>;
}

type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Era = { kind: "modern" } | { kind: "legacy"; version: string; sessionId: string | undefined };

type RpcError = { code: number; message: string; data?: unknown };
type Failure = { status: number; rpcError: RpcError | undefined; snippet: string };
type Answer =
  | { ok: true; result: Record<string, unknown>; headers: Headers }
  | { ok: false; failure: Failure };
type Outgoing = {
  method: string;
  params: Record<string, unknown>;
  /** `Mcp-Name`, for `tools/call`. */
  name?: string;
  /** `Mcp-Param-*` headers, sent to a 2026-07-28 server only. */
  paramHeaders?: Record<string, string>;
};

const RpcIdSchema = z.union([z.string(), z.number()]);
const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
const RpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema.nullish(),
  method: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: RpcErrorSchema.optional(),
});
type RpcMessage = z.infer<typeof RpcMessageSchema>;

const ListToolsResultSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      title: z.string().nullish(),
      description: z.string().nullish(),
      inputSchema: z.record(z.string(), z.unknown()),
      annotations: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
  nextCursor: z.string().nullish(),
});
const ContentSchema = z.union([
  z.looseObject({ type: z.literal("text"), text: z.string() }),
  z.looseObject({ type: z.string().refine((type) => type !== "text") }),
]);
const CallToolResultSchema = z.object({
  content: z.array(ContentSchema),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().nullish(),
});
const InitializeResultSchema = z.object({ protocolVersion: z.string() });
const SupportedVersionsSchema = z.object({ supported: z.array(z.string()) });

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseResult<T>(schema: z.ZodType<T>, result: Record<string, unknown>, method: string): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new McpError(
      "protocol",
      `the MCP server's ${method} result is malformed: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Reads at most `max` characters of a body, then cancels the rest. */
async function readText(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      text += decoder.decode(value, { stream: true });
      if (text.length > max) return { text: text.slice(0, max), truncated: true };
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * A session with one remote MCP server, over `fetch` (in Kerby, always `createEgressFetch`). Nothing is sent until
 * the first call. That call is sent as 2026-07-28; a 400, 404 or 405 whose body is not a 2026-07-28 error (header
 * mismatch, missing capability, unsupported version, method not found) means a handshake server: Kerby sends
 * `initialize` (2025-11-25), `notifications/initialized`, then the call again with the server's `Mcp-Session-Id`,
 * and remembers the era for the session's life. An `UnsupportedProtocolVersion` naming a handshake version Kerby
 * speaks falls back too. Errors of `fetch` itself (an egress refusal or timeout) pass through unchanged; an aborted
 * `signal` rejects with its reason.
 */
export function openMcpSession(options: {
  url: string;
  fetch: McpFetch;
  headers?: Record<string, string>;
  clientInfo: { name: string; version: string };
}): McpSession {
  const { url, fetch, clientInfo } = options;
  const callerHeaders = { ...options.headers };
  const secrets = Object.values(callerHeaders).filter((value) => value.length > 0);
  const host = new URL(url).host;
  let era: Era | undefined;
  let probing: Promise<unknown> | undefined;
  let nextId = 1;
  let closed = false;
  const cancellations = new Set<Promise<void>>();

  /** Server-supplied text with every caller header value (a credential the server may echo) taken out. */
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  };

  const headersFor = (current: Era | undefined): Headers => {
    const headers = new Headers(callerHeaders);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (current?.kind === "modern") headers.set("mcp-protocol-version", MODERN_VERSION);
    if (current?.kind === "legacy") {
      headers.set("mcp-protocol-version", current.version);
      if (current.sessionId !== undefined) headers.set("mcp-session-id", current.sessionId);
    }
    return headers;
  };

  const failureError = (failure: Failure, context = ""): McpError => {
    const { status, rpcError, snippet } = failure;
    if (rpcError) {
      return new McpError(
        "rpc",
        `${context}MCP error ${rpcError.code} (HTTP ${status}): ${scrub(rpcError.message)}`,
        { status, code: rpcError.code },
      );
    }
    const body = snippet.trim() ? `: ${scrub(snippet.trim().slice(0, 200))}` : "";
    return new McpError(
      "http",
      `${context}the MCP server at ${host} answered HTTP ${status}${body}`,
      {
        status,
      },
    );
  };

  async function readFailure(response: Response): Promise<Failure> {
    const { status } = response;
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new McpError(
        "unauthorized",
        `the MCP server at ${host} refused Kerby (HTTP ${status}): check the server's credential and its header`,
        { status },
      );
    }
    const { text } = await readText(response.body, MAX_ERROR_BODY_CHARS);
    let rpcError: RpcError | undefined;
    try {
      const parsed = RpcMessageSchema.safeParse(JSON.parse(text));
      if (parsed.success && parsed.data.error) rpcError = parsed.data.error;
    } catch {
      // Not JSON: a plain HTTP failure.
    }
    return { status, rpcError, snippet: text };
  }

  /** Answers a server's request on a handshake session: Kerby offers no client features. */
  async function refuseServerRequest(
    id: string | number,
    method: string,
    current: Era,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: headersFor(current),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Kerby declares no client capabilities; ${method} is not supported`,
        },
      }),
      signal,
    });
    await response.body?.cancel().catch(() => {});
  }

  /**
   * Handles one message from the server. Returns the result when it answers `id`; a server request is refused where
   * the transport allows a reply (a handshake session) and otherwise ignored, like notifications.
   */
  async function onMessage(
    value: unknown,
    id: number,
    current: Era | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const parsed = RpcMessageSchema.safeParse(value);
    if (!parsed.success) {
      throw new McpError(
        "protocol",
        `the MCP server sent a message that is not JSON-RPC 2.0: ${describeIssues(parsed.error)}`,
      );
    }
    const message: RpcMessage = parsed.data;
    if (message.method !== undefined) {
      if (message.id !== undefined && message.id !== null && current?.kind === "legacy") {
        await refuseServerRequest(message.id, message.method, current, signal).catch((error) => {
          if (signal.aborted) throw error;
        });
      }
      return undefined;
    }
    if (message.error && (message.id === id || message.id === null || message.id === undefined)) {
      throw new McpError(
        "rpc",
        `MCP error ${message.error.code}: ${scrub(message.error.message)}`,
        {
          code: message.error.code,
        },
      );
    }
    if (message.id !== id) {
      throw new McpError(
        "protocol",
        `the MCP server answered request id ${JSON.stringify(message.id)} while Kerby waited for ${id}`,
      );
    }
    if (!message.result) {
      throw new McpError("protocol", "the MCP server's response has neither result nor error");
    }
    return message.result;
  }

  async function readAnswer(
    response: Response,
    id: number,
    current: Era | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type === "application/json") {
      const { text, truncated } = await readText(response.body, MAX_MESSAGE_CHARS);
      if (truncated) {
        throw new McpError(
          "protocol",
          `the MCP server's response is over ${MAX_MESSAGE_CHARS} characters`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new McpError("protocol", "the MCP server's application/json response is not JSON");
      }
      for (const message of Array.isArray(value) ? value : [value]) {
        const result = await onMessage(message, id, current, signal);
        if (result) return result;
      }
      throw new McpError("protocol", `the MCP server's response does not answer request ${id}`);
    }
    if (type === "text/event-stream" && response.body) {
      for await (const event of readSse(response.body, MAX_MESSAGE_CHARS)) {
        if (event.data === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          throw new McpError(
            "protocol",
            "the MCP server sent a server-sent event that is not JSON",
          );
        }
        const result = await onMessage(value, id, current, signal);
        if (result) return result;
      }
      throw new McpError(
        "protocol",
        `the MCP server's event stream ended before answering request ${id}`,
      );
    }
    await response.body?.cancel().catch(() => {});
    throw new McpError(
      "protocol",
      `the MCP server answered HTTP ${response.status} with content type "${type ?? ""}"; MCP needs application/json or text/event-stream`,
    );
  }

  /** Sends one request on `current`'s terms (undefined: `initialize`, before the era is known). */
  async function send(
    current: Era | undefined,
    out: Outgoing,
    signal: AbortSignal,
  ): Promise<Answer> {
    const id = nextId++;
    const headers = headersFor(current);
    let params = out.params;
    if (current?.kind === "modern") {
      headers.set("mcp-method", out.method);
      if (out.name !== undefined) headers.set("mcp-name", encodeHeaderValue(out.name));
      for (const [name, value] of Object.entries(out.paramHeaders ?? {})) headers.set(name, value);
      const meta = isRecord(params._meta) ? params._meta : {};
      params = {
        ...params,
        _meta: {
          ...meta,
          [META_PROTOCOL_VERSION]: MODERN_VERSION,
          [META_CLIENT_INFO]: clientInfo,
          [META_CLIENT_CAPABILITIES]: {},
        },
      };
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method: out.method, params }),
        signal,
      });
      if (!response.ok) return { ok: false, failure: await readFailure(response) };
      const result = await readAnswer(response, id, current, signal);
      const resultType = result.resultType;
      if (resultType === "input_required") {
        throw new McpError(
          "protocol",
          `the MCP server asked for client input to finish ${out.method}; Kerby declares no client capabilities`,
        );
      }
      if (resultType !== undefined && resultType !== "complete") {
        throw new McpError(
          "protocol",
          `the MCP server's ${out.method} result has unknown resultType ${JSON.stringify(resultType)}`,
        );
      }
      return { ok: true, result, headers: response.headers };
    } catch (error) {
      if (!signal.aborted) throw error;
      if (current?.kind === "legacy") cancelLater(current, id);
      throw signal.reason;
    }
  }

  /** A handshake server keeps working on a request whose connection closed unless told (2025-11-25). */
  function cancelLater(current: Era, requestId: number): void {
    const sent = (async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: headersFor(current),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId, reason: "Kerby stopped waiting" },
        }),
      });
      await response.body?.cancel().catch(() => {});
    })().catch(() => {});
    cancellations.add(sent);
    void sent.finally(() => cancellations.delete(sent));
  }

  async function initialize(probe: Failure | undefined, signal: AbortSignal): Promise<Era> {
    const answer = await send(
      undefined,
      {
        method: "initialize",
        params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo },
      },
      signal,
    );
    if (!answer.ok) {
      throw failureError(
        answer.failure,
        probe
          ? `the MCP server answered neither ${MODERN_VERSION} (HTTP ${probe.status}) nor initialize: `
          : "initialize failed: ",
      );
    }
    const { protocolVersion } = parseResult(InitializeResultSchema, answer.result, "initialize");
    if (!LEGACY_VERSIONS.includes(protocolVersion)) {
      throw new McpError(
        "protocol",
        `the MCP server chose protocol version ${JSON.stringify(protocolVersion)}; Kerby speaks ${[MODERN_VERSION, ...LEGACY_VERSIONS].join(", ")}`,
      );
    }
    const sessionId = answer.headers.get("mcp-session-id") ?? undefined;
    if (sessionId !== undefined && !/^[\x21-\x7E]+$/.test(sessionId)) {
      throw new McpError("protocol", "the MCP server's Mcp-Session-Id is not visible ASCII");
    }
    const established: Era = { kind: "legacy", version: protocolVersion, sessionId };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: headersFor(established),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal,
      });
      if (!response.ok)
        throw failureError(await readFailure(response), "notifications/initialized: ");
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    return established;
  }

  /**
   * The first request decides the era. Success: 2026-07-28. A 2026-07-28 error in the body (header mismatch, missing
   * capability, method not found at 404): a modern server that refused, no fallback. Unsupported version: fall back
   * only if the server names a handshake version Kerby speaks. Any other 400, 404 or 405: a handshake server.
   */
  async function probe(out: Outgoing, signal: AbortSignal): Promise<Record<string, unknown>> {
    const answer = await send({ kind: "modern" }, out, signal);
    if (answer.ok) {
      era = { kind: "modern" };
      return answer.result;
    }
    const { failure } = answer;
    const code = failure.rpcError?.code;
    if (code === UNSUPPORTED_PROTOCOL_VERSION) {
      const parsed = SupportedVersionsSchema.safeParse(failure.rpcError?.data);
      const supported = parsed.success ? parsed.data.supported : [];
      if (!supported.some((version) => LEGACY_VERSIONS.includes(version))) {
        const spoken = supported.length > 0 ? ` (it speaks ${supported.join(", ")})` : "";
        throw failureError(
          failure,
          `the MCP server speaks none of ${[MODERN_VERSION, ...LEGACY_VERSIONS].join(", ")}${spoken}: `,
        );
      }
    } else if (
      code === HEADER_MISMATCH ||
      code === MISSING_CLIENT_CAPABILITY ||
      (code === METHOD_NOT_FOUND && failure.status === 404)
    ) {
      era = { kind: "modern" };
      throw failureError(failure);
    } else if (!FALLBACK_STATUSES.has(failure.status)) {
      throw failureError(failure);
    }
    era = await initialize(failure, signal);
    return onEra(era, out, signal);
  }

  /** Sends on a known era; a handshake session the server forgot (404) is made again once. */
  async function onEra(
    current: Era,
    out: Outgoing,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const answer = await send(current, out, signal);
    if (answer.ok) return answer.result;
    const expired =
      current.kind === "legacy" && current.sessionId !== undefined && answer.failure.status === 404;
    if (!expired) throw failureError(answer.failure);
    if (era === current) era = await initialize(undefined, signal);
    const again = await send(era ?? current, out, signal);
    if (again.ok) return again.result;
    throw failureError(again.failure);
  }

  async function rpc(out: Outgoing, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (closed) throw new Error("this MCP session is closed: open a new one with openMcpSession");
    signal.throwIfAborted();
    while (era === undefined && probing !== undefined) {
      // Another call is deciding the era: wait for it (or for this call's abort), then go again.
      const aborted = Promise.withResolvers<never>();
      const onAbort = () => aborted.reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([probing.catch(() => {}), aborted.promise]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
    if (era !== undefined) return onEra(era, out, signal);
    const first = probe(out, signal);
    probing = first;
    try {
      return await first;
    } finally {
      if (probing === first) probing = undefined;
    }
  }

  return {
    async listTools(signal) {
      const tools: McpToolListing[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await rpc(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          signal,
        );
        const listed = parseResult(ListToolsResultSchema, result, "tools/list");
        for (const tool of listed.tools) {
          // 2026-07-28: a tool whose x-mcp-header annotations are invalid must not be offered.
          if (era?.kind === "modern" && "invalid" in mcpHeaderParams(tool.inputSchema)) continue;
          const listing: McpToolListing = {
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
          };
          if (tool.title != null) listing.title = tool.title;
          if (tool.annotations != null) listing.annotations = tool.annotations;
          tools.push(listing);
        }
        if (listed.nextCursor == null) return tools;
        cursor = listed.nextCursor;
      }
      throw new McpError(
        "protocol",
        `the MCP server's tools/list did not end within ${MAX_LIST_PAGES} pages`,
      );
    },

    async callTool(name, args, { callId, signal, inputSchema }) {
      const headerParams = inputSchema ? mcpHeaderParams(inputSchema) : undefined;
      const result = await rpc(
        {
          method: "tools/call",
          params: { name, arguments: args, _meta: { [MCP_CALL_ID_META_KEY]: callId } },
          name,
          paramHeaders:
            headerParams && "params" in headerParams
              ? mcpParamHeaders(headerParams.params, args)
              : {},
        },
        signal,
      );
      const call = parseResult(CallToolResultSchema, result, "tools/call");
      const outcome: McpCallOutcome = {
        content: call.content as McpContent[],
        isError: call.isError === true,
      };
      if (call.structuredContent !== undefined) outcome.structuredContent = call.structuredContent;
      return outcome;
    },

    async close() {
      closed = true;
      await Promise.all(cancellations);
      if (era?.kind !== "legacy" || era.sessionId === undefined) return;
      const headers = headersFor(era);
      headers.delete("content-type");
      try {
        const response = await fetch(url, { method: "DELETE", headers });
        await response.body?.cancel().catch(() => {});
      } catch {
        // Best effort: the server expires the session on its own (405 or 404 are fine too).
      }
    },
  };
}
