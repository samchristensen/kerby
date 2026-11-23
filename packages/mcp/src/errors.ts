type McpErrorKind = "unauthorized" | "http" | "protocol" | "rpc";

/** A server's JSON-RPC error message, an id it echoed, or any other text of its in an McpError, at most. */
const MAX_SERVER_TEXT_CHARS = 2_000;

/** `text` cut to `MAX_SERVER_TEXT_CHARS`, saying so. */
export const clip = (text: string): string =>
  text.length <= MAX_SERVER_TEXT_CHARS ? text : `${text.slice(0, MAX_SERVER_TEXT_CHARS)}…[cut]`;

/**
 * A remote MCP server failed a request. `unauthorized`: HTTP 401 or 403 (the credential is wrong or missing).
 * `http`: any other non-success status, with `status` (a redirect too: Kerby never follows one). `protocol`: the
 * server's answer is not valid MCP (not JSON-RPC, a wrong id, a malformed or oversized result, a version Kerby does
 * not speak, a listing past its limits). `rpc`: the server answered with a JSON-RPC error, with its `code` (and
 * `status` when it came with a non-success HTTP status). `afterResponse`: the error is about the server's response to
 * the request itself (`tools/call`, `tools/list`), not to a handshake step before it: the request reached the server,
 * so a call may have run. Messages never carry header values, and quote at most `MAX_SERVER_TEXT_CHARS` of any text
 * of the server's.
 */
export class McpError extends Error {
  override name = "McpError";
  readonly kind: McpErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly afterResponse: boolean;

  constructor(
    kind: McpErrorKind,
    message: string,
    details: {
      status?: number | undefined;
      code?: number | undefined;
      afterResponse?: boolean | undefined;
    } = {},
  ) {
    super(message);
    this.kind = kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    this.afterResponse = details.afterResponse ?? false;
  }

  /** The same error, marked as one about the response to the request itself. */
  answered(): McpError {
    if (this.afterResponse) return this;
    return new McpError(this.kind, this.message, {
      status: this.status,
      code: this.code,
      afterResponse: true,
    });
  }
}
