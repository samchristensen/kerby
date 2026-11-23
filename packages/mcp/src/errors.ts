type McpErrorKind = "unauthorized" | "http" | "protocol" | "rpc";

/**
 * A remote MCP server failed a request. `unauthorized`: HTTP 401 or 403 (the credential is wrong or missing).
 * `http`: any other non-success status, with `status`. `protocol`: the server's answer is not valid MCP (not JSON-RPC,
 * a wrong id, a malformed result, a version Kerby does not speak). `rpc`: the server answered with a JSON-RPC error,
 * with its `code` (and `status` when it came with a non-success HTTP status). Messages never carry header values.
 */
export class McpError extends Error {
  override name = "McpError";
  readonly kind: McpErrorKind;
  readonly status?: number;
  readonly code?: number;

  constructor(
    kind: McpErrorKind,
    message: string,
    details: { status?: number | undefined; code?: number | undefined } = {},
  ) {
    super(message);
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
  }
}
