// Listing a tenant's MCP server (ADR 0019): the `sync-tool-server` task. Only a worker can open the server's credential,
// so only a worker lists its tools; the registry (`recordSync`) decides what the listing changes: a new tool arrives
// disabled, an enabled tool keeps the definition an admin approved.
import type { TenantContext } from "@kerby/db";
import type { RunContext, TaskParams } from "@kerby/durable";
import { openMcpSession } from "@kerby/mcp";
import { log } from "@kerby/observability";
import {
  findToolServerById,
  recordSync,
  type SyncOutcome,
  ToolServerNotFoundError,
} from "@kerby/tools";
import type { WorkerDeps } from "../types/index.ts";
import { MCP_CLIENT_INFO, toolServerHeaders, whyToolFailed } from "./mcp.ts";

/** A listing takes at most this long, every page included. */
const SYNC_TIMEOUT_MS = 30_000;

export async function syncToolServer(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["sync-tool-server"],
  run: RunContext,
): Promise<void> {
  const server = await findToolServerById(ctx.db, params.serverId);
  // Deleted since it was queued, or the built-in one (its tools are code): nothing to list.
  if (!server || server.kind !== "mcp" || server.url === null) return;
  const headers = await toolServerHeaders(deps, ctx.tenantId, server);
  let outcome: SyncOutcome;
  if ("missing" in headers) {
    outcome = { error: headers.missing };
  } else {
    const session = openMcpSession({
      url: server.url,
      fetch: deps.toolFetch,
      headers: headers.headers,
      clientInfo: MCP_CLIENT_INFO,
    });
    try {
      const listed = await session.listTools(
        AbortSignal.any([run.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
      );
      outcome = {
        tools: listed.map((tool) => ({
          name: tool.name,
          definition: {
            ...(tool.title === undefined ? {} : { title: tool.title }),
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          },
        })),
      };
    } catch (error) {
      // A lost lease is not the server's failure: let Absurd hand the task to the run that owns it now.
      if (run.signal.aborted) throw error;
      outcome = { error: whyToolFailed(error, headers.secret, "listing its tools") };
    } finally {
      await session.close().catch(() => undefined);
    }
  }
  try {
    await recordSync(ctx.db, server.id, outcome);
  } catch (error) {
    if (error instanceof ToolServerNotFoundError) return;
    throw error;
  }
  log("info", "tool server listed", {
    serverId: server.id,
    ok: !("error" in outcome),
    tools: "tools" in outcome ? outcome.tools.length : 0,
  });
}
