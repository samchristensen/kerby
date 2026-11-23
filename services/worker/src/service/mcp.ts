// What listing a tenant's MCP server and calling its tools share (ADR 0019): the credential in its header, and an
// account of a failure the tenant may read (a sync's `last_error`, a tool's error result) that never holds the credential.
import { EgressError } from "@kerby/egress";
import { McpError } from "@kerby/mcp";
import type { ToolServerRecord } from "@kerby/tools";
import type { WorkerDeps } from "../types/index.ts";

export const MCP_CLIENT_INFO = { name: "kerby", version: "1" };

/**
 * The headers a server's auth needs: its credential, opened, in the header the tenant named. `secret` is what must be
 * scrubbed from anything the server answers. `missing` says why there is no credential to send.
 */
export async function toolServerHeaders(
  deps: WorkerDeps,
  tenantId: string,
  server: Pick<ToolServerRecord, "id" | "slug" | "auth">,
): Promise<{ headers: Record<string, string>; secret: string | undefined } | { missing: string }> {
  if (server.auth.kind === "none") return { headers: {}, secret: undefined };
  if (!deps.toolCredentials)
    return { missing: "this worker cannot open tool credentials: SECRETS_PRIVATE_KEYS is not set" };
  const credential = await deps.toolCredentials(tenantId, server.id);
  if (!credential)
    return {
      missing: `no credential is stored for "${server.slug}": PUT /v1/tool-servers/${server.slug}/credential`,
    };
  return { headers: { [server.auth.header]: credential }, secret: credential };
}

/** Why an exchange with a server failed, in words the tenant can act on, with the credential scrubbed out. */
export function whyToolFailed(error: unknown, secret: string | undefined, doing: string): string {
  let why: string;
  if (error instanceof McpError && error.kind === "unauthorized")
    why = `the server refused the credential (HTTP ${error.status ?? "401"}): check it with PUT /v1/tool-servers/<server>/credential`;
  else if (error instanceof McpError) why = error.message;
  else if (error instanceof EgressError && error.reason === "timeout")
    why = "the server did not answer in time";
  else if (error instanceof EgressError)
    why = `the address was refused (${error.reason}): ${error.message}`;
  else if (error instanceof DOMException && error.name === "TimeoutError")
    why = "the server did not answer in time";
  else why = error instanceof Error ? error.message : String(error);
  const text = `${doing} failed: ${why}`;
  return secret ? text.replaceAll(secret, "[redacted]") : text;
}
