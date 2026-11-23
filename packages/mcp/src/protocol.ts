// MCP wire constants and the Streamable HTTP header rules both the client and the test fixture follow.

/** The stateless revision Kerby tries first: every request carries its version, no `initialize`, no session. */
export const MODERN_VERSION = "2026-07-28";
/** Handshake revisions Kerby falls back to, newest first (Streamable HTTP began with 2025-03-26). */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
/** Where a tool call carries Kerby's call id, for servers that deduplicate retried calls (ADR 0019). */
export const MCP_CALL_ID_META_KEY = "kerby/callId";

/** JSON-RPC codes a 2026-07-28 server answers with; one of them means "modern server, do not fall back". */
export const HEADER_MISMATCH = -32020;
export const MISSING_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const METHOD_NOT_FOUND = -32601;

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";
// Visible ASCII, with spaces and tabs only inside: what RFC 9110 lets a header value carry as is.
const PLAIN_HEADER_VALUE = /^(?:[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?)?$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A value for `Mcp-Name` or `Mcp-Param-*`: as is when header-safe, else the `=?base64?…?=` sentinel form. */
export function encodeHeaderValue(value: string): string {
  const looksEncoded = value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX);
  if (PLAIN_HEADER_VALUE.test(value) && !looksEncoded) return value;
  return `${SENTINEL_PREFIX}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_SUFFIX}`;
}

export function decodeHeaderValue(value: string): string {
  if (!value.startsWith(SENTINEL_PREFIX) || !value.endsWith(SENTINEL_SUFFIX)) return value;
  const encoded = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length);
  return Buffer.from(encoded, "base64").toString("utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type HeaderParam = { header: string; path: string[] };

/**
 * The `x-mcp-header` annotations of a tool's input schema (2026-07-28), or why they are invalid: on a property not
 * reached from the root through `properties` alone, not a header token, on a type other than string, integer or
 * boolean, or repeated. A client must not offer a tool whose annotations are invalid.
 */
export function mcpHeaderParams(
  inputSchema: Record<string, unknown>,
): { params: HeaderParam[] } | { invalid: string } {
  const params: HeaderParam[] = [];
  const problems: string[] = [];
  const visit = (node: unknown, path: string[] | undefined, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, undefined, `${where}[${index}]`);
      });
      return;
    }
    if (!isRecord(node)) return;
    if ("x-mcp-header" in node) {
      const header = node["x-mcp-header"];
      if (path === undefined || path.length === 0) {
        problems.push(
          `${where} has x-mcp-header but is not a property reached through "properties"`,
        );
      } else if (typeof header !== "string" || !TOKEN.test(header)) {
        problems.push(`${where} has an x-mcp-header that is not a header name`);
      } else if (!["string", "integer", "boolean"].includes(String(node.type))) {
        problems.push(`${where} has x-mcp-header on a type other than string, integer or boolean`);
      } else {
        params.push({ header, path });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "x-mcp-header") continue;
      if (key === "properties" && isRecord(child)) {
        // A property's name is not a keyword: visit each property's schema, never the map itself.
        for (const [name, schema] of Object.entries(child)) {
          visit(schema, path && [...path, name], `${where}.properties.${name}`);
        }
      } else {
        visit(child, undefined, `${where}.${key}`);
      }
    }
  };
  visit(inputSchema, [], "inputSchema");
  const seen = new Set<string>();
  for (const { header } of params) {
    const lower = header.toLowerCase();
    if (seen.has(lower)) problems.push(`x-mcp-header "${header}" is used twice`);
    seen.add(lower);
  }
  return problems.length > 0 ? { invalid: problems.join("; ") } : { params };
}

/** The `Mcp-Param-*` headers of one call: each annotated argument that is present, encoded. */
export function mcpParamHeaders(
  params: readonly HeaderParam[],
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, path } of params) {
    let value: unknown = args;
    for (const key of path) value = isRecord(value) ? value[key] : undefined;
    let text: string | undefined;
    if (typeof value === "string") text = value;
    else if (typeof value === "boolean") text = String(value);
    else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
    if (text !== undefined) headers[`mcp-param-${header.toLowerCase()}`] = encodeHeaderValue(text);
  }
  return headers;
}
