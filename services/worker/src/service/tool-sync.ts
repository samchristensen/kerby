// Listing a tenant's MCP server (ADR 0019): the `sync-tool-server` task. Only a worker can open the server's credential,
// so only a worker lists its tools; the registry (`recordSync`) decides what the listing changes: a new tool arrives
// disabled, an enabled tool keeps the definition an admin approved.
import { MAX_TOOLS_PER_SERVER } from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import type { RunContext, TaskParams } from "@kerby/durable";
import { type McpToolListing, openMcpSession } from "@kerby/mcp";
import { errorFields, log } from "@kerby/observability";
import {
  findToolServerById,
  recordSync,
  type SyncOutcome,
  ToolServerNotFoundError,
} from "@kerby/tools";
import type { WorkerDeps } from "../types/index.ts";
import {
  afterRefusal,
  MCP_CLIENT_INFO,
  type ServerAuth,
  toolServerHeaders,
  whyToolFailed,
} from "./mcp.ts";

/** A listing takes at most this long, every page included. */
const SYNC_TIMEOUT_MS = 30_000;
/** Decoded bytes of one listing, every page included; a server past it is a sync error. */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

export async function syncToolServer(
  deps: WorkerDeps,
  ctx: TenantContext,
  params: TaskParams["sync-tool-server"],
  run: RunContext,
): Promise<void> {
  const server = await findToolServerById(ctx.db, params.serverId);
  // Deleted since it was queued, or the built-in one (its tools are code): nothing to list.
  if (server?.kind !== "mcp" || server.url === null) return;
  const url = server.url;
  const list = async (headers: Record<string, string>): Promise<McpToolListing[]> => {
    const session = openMcpSession({
      url,
      fetch: deps.syncFetch,
      headers,
      clientInfo: MCP_CLIENT_INFO,
    });
    try {
      return await session.listTools(
        AbortSignal.any([run.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS)]),
        { maxTools: MAX_TOOLS_PER_SERVER, maxBytes: MAX_LISTING_BYTES },
      );
    } finally {
      await session.close().catch(() => undefined);
    }
  };
  const secrets: string[] = [];
  let outcome: SyncOutcome | undefined;
  try {
    let auth: ServerAuth = await toolServerHeaders(deps, ctx.tenantId, server, run.signal);
    // An OAuth server that refuses its token gets one refresh and one more try.
    for (let attempt = 0; outcome === undefined; attempt++) {
      if ("missing" in auth) {
        outcome = { error: auth.missing };
        break;
      }
      secrets.push(...auth.secrets);
      try {
        const listed = await list(auth.headers);
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
        const again =
          attempt === 0
            ? afterRefusal(deps, ctx.tenantId, server, auth, error, run.signal)
            : undefined;
        if (again === undefined)
          outcome = { error: whyToolFailed(error, secrets, "listing its tools", server) };
        else auth = await again;
      }
    }
  } catch (error) {
    // Before any listing: the credential could not be read, or a refresh failed. Another attempt may do better; the
    // last one records why, so the server does not stay `syncing` for good.
    if (run.signal.aborted || run.maxAttempts === null || run.attempt < run.maxAttempts)
      throw error;
    log("error", "tool server listing failed for good", {
      serverId: server.id,
      ...errorFields(error),
    });
    outcome = { error: whyToolFailed(error, secrets, "listing its tools", server) };
  }
  let recorded: boolean;
  try {
    // Fenced: a change to the server since this listing began queued a listing of its own, which wins.
    recorded = await recordSync(ctx.db, server.id, outcome, server.updatedAt);
  } catch (error) {
    if (error instanceof ToolServerNotFoundError) return;
    throw error;
  }
  log("info", "tool server listed", {
    serverId: server.id,
    ok: !("error" in outcome),
    tools: "tools" in outcome ? outcome.tools.length : 0,
    stale: !recorded,
  });
}
