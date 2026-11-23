// Tools (ADR 0022): the tenant's tool servers, their tools, integrations' grants, and what a caller may name. Every
// change that could alter what a server lists enqueues a `sync-tool-server` task in the same tenant transaction; only
// a worker lists tools. A credential is sealed into the control plane before that transaction commits, so the worker
// never lists without it, and never comes back out.
import { randomUUID } from "node:crypto";
import type {
  AvailableTool,
  CreateToolServerRequest,
  ListAvailableToolsResponse,
  ListIntegrationsResponse,
  ListToolServersResponse,
  Tool,
  ToolGrants,
  ToolServer,
  ToolServerAuth,
  UpdateToolRequest,
  UpdateToolServerRequest,
} from "@kerby/contracts";
import {
  BUILTIN_TOOL_SERVER,
  DEFAULT_JUDGMENT_MODEL,
  exposedToolName,
  MAX_CONVERSATION_TOOLS,
  parseModelId,
  parseToolPattern,
  toolPattern,
} from "@kerby/contracts";
import {
  audit,
  deleteToolCredential,
  getIntegration,
  hasModelKey,
  hasToolCredential,
  hintTenantWork,
  listIntegrations,
  putToolCredential,
} from "@kerby/control-plane";
import type { TenantContext, TenantQueryable, TenantTx } from "@kerby/db";
import { spawnInTx } from "@kerby/durable";
import { errorFields, log } from "@kerby/observability";
import {
  BuiltinToolServerError,
  createToolServer,
  definitionHash,
  deleteToolServer,
  findToolServer,
  getGrants,
  listServerGrants,
  listToolServers,
  listTools,
  type OfferedTool,
  offeredTools,
  resolveToolPatterns,
  setGrants,
  type ToolRecord,
  type ToolRef,
  ToolServerNotFoundError,
  type ToolServerRecord,
  toolPatterns,
  UnknownToolError,
  uncoveredBy,
  updateTool,
  updateToolServer,
} from "@kerby/tools";
import { type ApiDeps, NotFoundError, type Principal } from "../types/index.ts";

/** The caller's grants do not cover tools it named, or tools of the conversation it posts to. */
export class ToolNotGrantedError extends Error {
  override name = "ToolNotGrantedError";
}

/** More than `MAX_CONVERSATION_TOOLS` tools would be offered to a turn. */
export class TooManyToolsError extends Error {
  override name = "TooManyToolsError";
}

/** A tool server change that cannot be made as asked (a credential without header auth, plain http with one). */
export class ToolServerRequestError extends Error {
  override name = "ToolServerRequestError";
}

const SERVER_NOT_FOUND = "no tool server by that name: list them with GET /v1/tool-servers";

// --- what a caller may use -------------------------------------------------------------------------------------

/** Why a built-in tool is not available to this tenant here, or undefined when it is. */
async function builtinUnavailable(
  deps: ApiDeps,
  tenantId: string,
  name: string,
): Promise<string | undefined> {
  if (name === "echo")
    return deps.settings.enableEchoTool ? undefined : "a development tool, not offered here";
  if (name === "judge") {
    const provider = parseModelId(DEFAULT_JUDGMENT_MODEL)?.provider ?? DEFAULT_JUDGMENT_MODEL;
    return (await hasModelKey(deps.control, tenantId, provider))
      ? undefined
      : `needs a key for ${provider}: PUT /v1/model-keys/${provider}`;
  }
  return undefined;
}

/** `offered` without the built-ins this tenant cannot use here. */
async function withoutUnavailable(
  deps: ApiDeps,
  tenantId: string,
  offered: OfferedTool[],
): Promise<OfferedTool[]> {
  const kept: OfferedTool[] = [];
  for (const tool of offered)
    if (tool.server.kind !== "builtin" || !(await builtinUnavailable(deps, tenantId, tool.tool)))
      kept.push(tool);
  return kept;
}

/**
 * Whether the caller may name every enabled tool: an integration with `admin`, or a console session (which acts as the
 * tenant, ADR 0020). Any other integration holds only its grants.
 */
export const holdsEveryTool = (principal: Principal): boolean =>
  principal.integrationId === null || principal.scopes.has("admin");

/** What the caller holds: every tool, or its integration's grants. */
async function holdings(db: TenantQueryable, principal: Principal): Promise<ToolRef[] | "all"> {
  const { integrationId } = principal;
  if (integrationId === null || principal.scopes.has("admin")) return "all";
  return getGrants(db, integrationId);
}

/** Refuse when the caller's grants do not cover every one of `refs`. No refs: nothing to hold, and no query. */
export async function assertHolds(
  db: TenantQueryable,
  principal: Principal,
  refs: ToolRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const held = await holdings(db, principal);
  if (held === "all") return;
  const missing = uncoveredBy(held, refs);
  if (missing.length === 0) return;
  const patterns = await toolPatterns(db, missing);
  throw new ToolNotGrantedError(
    `this key's integration may not use ${patterns.join(", ")}: an admin grants tools on the integration (PUT /v1/integrations/:id/tools)`,
  );
}

/**
 * The refs a new conversation's `patterns` name, checked for the caller: each names a usable tool (built-ins
 * included), the caller holds them all, and they stand for at most `MAX_CONVERSATION_TOOLS` tools now.
 */
export async function conversationToolRefs(
  deps: ApiDeps,
  db: TenantQueryable,
  tenantId: string,
  principal: Principal,
  patterns: string[],
): Promise<ToolRef[]> {
  const problems: { pattern: string; reason: string }[] = [];
  for (const pattern of patterns) {
    const parts = parseToolPattern(pattern);
    if (parts?.slug !== BUILTIN_TOOL_SERVER || parts.tool === null) continue;
    const reason = await builtinUnavailable(deps, tenantId, parts.tool);
    if (reason !== undefined) problems.push({ pattern, reason });
  }
  let refs: ToolRef[] = [];
  try {
    refs = await resolveToolPatterns(db, patterns);
  } catch (error) {
    if (!(error instanceof UnknownToolError)) throw error;
    const named = new Set(problems.map((problem) => problem.pattern));
    problems.push(...error.problems.filter((problem) => !named.has(problem.pattern)));
  }
  if (problems.length > 0) throw new UnknownToolError(problems);
  await assertHolds(db, principal, refs);
  const offered = await withoutUnavailable(deps, tenantId, await offeredTools(db, refs));
  if (offered.length > MAX_CONVERSATION_TOOLS)
    throw new TooManyToolsError(
      `these tools stand for ${offered.length} tools; a conversation may use at most ${MAX_CONVERSATION_TOOLS}: name fewer, or single tools instead of <server>/*`,
    );
  return refs;
}

/** `GET /v1/tools`: the enabled tools the caller may name, built-ins it cannot use here left out. */
export async function listAvailableTools(
  deps: ApiDeps,
  ctx: TenantContext,
  principal: Principal,
): Promise<ListAvailableToolsResponse> {
  const offered = await offeredTools(ctx.db, await holdings(ctx.db, principal));
  const tools: AvailableTool[] = (await withoutUnavailable(deps, ctx.tenantId, offered)).map(
    (tool) => ({
      pattern: tool.pattern,
      exposedName: tool.exposedName,
      title: tool.definition.title ?? null,
      description: tool.definition.description,
      inputSchema: tool.definition.inputSchema,
      effect: tool.effect,
    }),
  );
  return { tools };
}

// --- servers ---------------------------------------------------------------------------------------------------

function toolResource(slug: string, tool: ToolRecord): Tool {
  return {
    name: tool.name,
    pattern: toolPattern(slug, tool.name),
    exposedName: exposedToolName(slug, tool.name) ?? null,
    enabled: tool.enabled,
    effect: tool.effect,
    drifted: tool.drifted,
    removed: tool.removedAt !== null,
    definition: tool.pinned,
    listed: tool.drifted ? tool.listed : null,
    listedHash: definitionHash(tool.listed),
  };
}

const summary = (
  server: ToolServerRecord,
  counts: { toolCount: number; enabledCount: number; driftedCount: number },
  hasCredential: boolean,
) => ({
  slug: server.slug,
  kind: server.kind,
  url: server.url,
  auth: server.auth,
  hasCredential,
  status: server.status,
  lastError: server.lastError,
  syncedAt: server.syncedAt?.toISOString() ?? null,
  toolCount: counts.toolCount,
  enabledCount: counts.enabledCount,
  driftedCount: counts.driftedCount,
  createdAt: server.createdAt.toISOString(),
  updatedAt: server.updatedAt.toISOString(),
});

const credentialOf = (deps: ApiDeps, tenantId: string, server: ToolServerRecord) =>
  server.kind === "builtin"
    ? Promise.resolve(false)
    : hasToolCredential(deps.control, tenantId, server.id);

export async function listTenantToolServers(
  deps: ApiDeps,
  ctx: TenantContext,
): Promise<ListToolServersResponse> {
  const servers = await listToolServers(ctx.db);
  return {
    servers: await Promise.all(
      servers.map(async (server) =>
        summary(server, server, await credentialOf(deps, ctx.tenantId, server)),
      ),
    ),
  };
}

export async function serverResource(
  deps: ApiDeps,
  ctx: TenantContext,
  server: ToolServerRecord,
): Promise<ToolServer> {
  const [tools, grants, hasCredential, integrations] = await Promise.all([
    listTools(ctx.db, server.id),
    listServerGrants(ctx.db, server.id),
    credentialOf(deps, ctx.tenantId, server),
    listIntegrations(deps.control, ctx.tenantId),
  ]);
  const live = tools.filter((tool) => tool.removedAt === null);
  // A deleted integration's grants stay behind, inert (it has no live key): they are not shown.
  const liveIntegrations = new Set(integrations.map((integration) => integration.id));
  return {
    ...summary(
      server,
      {
        toolCount: live.length,
        enabledCount: live.filter((tool) => tool.enabled).length,
        driftedCount: live.filter((tool) => tool.drifted).length,
      },
      hasCredential,
    ),
    tools: tools.map((tool) => toolResource(server.slug, tool)),
    grantedTo: grants
      .filter((grant) => liveIntegrations.has(grant.integrationId))
      .map((grant) => ({
        integrationId: grant.integrationId,
        pattern: toolPattern(server.slug, grant.tool),
      })),
  };
}

async function serverBySlug(db: TenantQueryable, slug: string): Promise<ToolServerRecord> {
  const server = await findToolServer(db, slug);
  if (!server) throw new ToolServerNotFoundError(SERVER_NOT_FOUND);
  return server;
}

/** Refuses the built-in server, which is served from code. */
export async function remoteServer(db: TenantQueryable, slug: string): Promise<ToolServerRecord> {
  const server = await serverBySlug(db, slug);
  if (server.kind === "builtin")
    throw new BuiltinToolServerError(
      `"${BUILTIN_TOOL_SERVER}" is Kerby's own server, served from code: it cannot be changed, synced or deleted`,
    );
  return server;
}

export async function getTenantToolServer(
  deps: ApiDeps,
  ctx: TenantContext,
  slug: string,
): Promise<ToolServer> {
  return serverResource(deps, ctx, await serverBySlug(ctx.db, slug));
}

/** Enqueue the listing on `tx`: it exists exactly when the change that asked for it commits. */
export const enqueueSync = (tx: TenantTx, serverId: string) =>
  spawnInTx(tx, "sync-tool-server", { serverId }, { idempotencyKey: `sync:${randomUUID()}` });

/** Mark the tenant due and ring the workers (ADR 0004's wake-ups); the full sweep finds the sync if this is lost. */
export const notifyWorkers = (deps: ApiDeps, tenantId: string) =>
  hintTenantWork(deps.control, tenantId).catch((error: unknown) => {
    log("warn", "could not hint workers; the full sweep will find the sync", errorFields(error));
  });

const authDetail = (auth: ToolServerAuth) => ({
  auth: auth.kind,
  header: auth.kind === "header" ? auth.header : null,
  ...(auth.kind === "oauth" ? { scope: auth.scope ?? null } : {}),
});

/**
 * An OAuth server's URL must be https, like every URL its tokens go to; plain http only from a development stack's
 * named hosts (`EGRESS_ALLOWED_HOSTS`).
 */
export function checkOAuthUrl(deps: ApiDeps, url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && deps.settings.insecureOAuthHosts.includes(parsed.hostname))
  )
    throw new ToolServerRequestError("a server connected with OAuth must use https: change url");
}

export async function createTenantToolServer(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  request: CreateToolServerRequest,
): Promise<ToolServer> {
  if (request.auth.kind === "oauth") checkOAuthUrl(deps, request.url);
  const server = await ctx.db.transaction(async (tx) => {
    const created = await createToolServer(tx, {
      slug: request.slug,
      url: request.url,
      auth: request.auth,
    });
    if (request.credential !== undefined)
      await putToolCredential(
        deps.control,
        deps.sealer,
        ctx.tenantId,
        created.id,
        request.credential,
      );
    await enqueueSync(tx, created.id);
    return created;
  });
  await notifyWorkers(deps, ctx.tenantId);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.create",
    detail: {
      serverId: server.id,
      slug: server.slug,
      url: new URL(request.url).origin,
      ...authDetail(server.auth),
    },
  });
  return serverResource(deps, ctx, server);
}

export async function updateTenantToolServer(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  slug: string,
  request: UpdateToolServerRequest,
): Promise<ToolServer> {
  const current = await remoteServer(ctx.db, slug);
  const auth = request.auth ?? current.auth;
  const url = request.url ?? current.url ?? "";
  if (auth.kind !== "header" && request.credential !== undefined)
    throw new ToolServerRequestError(
      "a credential goes with auth.kind header: set auth to header, or leave the credential out",
    );
  if (auth.kind === "header") {
    if (!url.startsWith("https://"))
      throw new ToolServerRequestError("a server with a credential must use https: change url");
    // What is stored for a server that was not on header auth is not a header's value (an OAuth connection's tokens).
    if (
      request.credential === undefined &&
      !(
        current.auth.kind === "header" &&
        (await hasToolCredential(deps.control, ctx.tenantId, current.id))
      )
    )
      throw new ToolServerRequestError(
        "header auth needs a credential and this server has none: send credential with it",
      );
  }
  if (auth.kind === "oauth") checkOAuthUrl(deps, url);
  // The stored credential no longer applies when the kind of auth changes, or when an OAuth server moves: its tokens
  // are bound to the old address (RFC 8707) and must never be sent to the new one. Dropped before the change commits,
  // so no worker sees the new row with the old credential.
  const dropCredential =
    request.credential === undefined &&
    (auth.kind !== current.auth.kind || (auth.kind === "oauth" && url !== current.url));
  const server = await ctx.db.transaction(async (tx) => {
    const updated = await updateToolServer(tx, current.id, {
      url: request.url,
      auth: request.auth,
    });
    if (request.credential !== undefined)
      await putToolCredential(
        deps.control,
        deps.sealer,
        ctx.tenantId,
        current.id,
        request.credential,
      );
    if (dropCredential) await deleteToolCredential(deps.control, ctx.tenantId, current.id);
    await enqueueSync(tx, current.id);
    return updated;
  });
  await notifyWorkers(deps, ctx.tenantId);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.update",
    detail: {
      serverId: server.id,
      slug: server.slug,
      url: server.url === null ? null : new URL(server.url).origin,
      ...authDetail(server.auth),
      credentialReplaced: request.credential !== undefined,
    },
  });
  return serverResource(deps, ctx, server);
}

/** Replace a header-auth server's credential and list its tools again with it. */
export async function putTenantToolCredential(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  slug: string,
  value: string,
): Promise<ToolServer> {
  const current = await remoteServer(ctx.db, slug);
  if (current.auth.kind !== "header")
    throw new ToolServerRequestError(
      current.auth.kind === "oauth"
        ? `this server connects with OAuth, which stores its own tokens: connect it again with POST /v1/tool-servers/${slug}/oauth/start (Connect in the console)`
        : `this server uses no credential (auth none): PATCH /v1/tool-servers/${slug} with auth.kind header and the credential`,
    );
  const server = await ctx.db.transaction(async (tx) => {
    const updated = await updateToolServer(tx, current.id, {});
    await putToolCredential(deps.control, deps.sealer, ctx.tenantId, current.id, value);
    await enqueueSync(tx, current.id);
    return updated;
  });
  await notifyWorkers(deps, ctx.tenantId);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.credential",
    detail: { serverId: server.id, slug: server.slug },
  });
  return serverResource(deps, ctx, server);
}

/** List the server's tools again. */
export async function syncTenantToolServer(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  slug: string,
): Promise<ToolServer> {
  const current = await remoteServer(ctx.db, slug);
  const server = await ctx.db.transaction(async (tx) => {
    const updated = await updateToolServer(tx, current.id, {});
    await enqueueSync(tx, current.id);
    return updated;
  });
  await notifyWorkers(deps, ctx.tenantId);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.sync",
    detail: { serverId: server.id, slug: server.slug },
  });
  return serverResource(deps, ctx, server);
}

/** Delete the server with its tools, grants and conversations' use of it, then its credential. */
export async function deleteTenantToolServer(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  slug: string,
): Promise<void> {
  const server = await remoteServer(ctx.db, slug);
  if (!(await deleteToolServer(ctx.db, server.id)))
    throw new ToolServerNotFoundError(SERVER_NOT_FOUND);
  await deleteToolCredential(deps.control, ctx.tenantId, server.id);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool_server.delete",
    detail: { serverId: server.id, slug: server.slug },
  });
}

export async function updateTenantTool(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  slug: string,
  name: string,
  request: UpdateToolRequest,
): Promise<Tool> {
  const server = await remoteServer(ctx.db, slug);
  const tool = await updateTool(ctx.db, server.id, name, request);
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "tool.update",
    detail: {
      serverId: server.id,
      slug: server.slug,
      tool: tool.name,
      enabled: request.enabled ?? null,
      effect: request.effect ?? null,
      acceptDefinition: request.acceptDefinition ?? false,
    },
  });
  return toolResource(server.slug, tool);
}

// --- integrations ----------------------------------------------------------------------------------------------

export async function listTenantIntegrations(
  deps: ApiDeps,
  principal: Principal,
): Promise<ListIntegrationsResponse> {
  const integrations = await listIntegrations(deps.control, principal.tenantId);
  return {
    integrations: integrations.map((integration) => ({
      id: integration.id,
      name: integration.name,
      scopes: integration.scopes,
      createdAt: integration.createdAt.toISOString(),
    })),
  };
}

/** A live integration of the caller's tenant; another tenant's id is simply not found. */
async function integrationId(deps: ApiDeps, tenantId: string, id: string): Promise<string> {
  const integration = await getIntegration(deps.control, tenantId, id);
  if (!integration)
    throw new NotFoundError("no integration with that id: list them with GET /v1/integrations");
  return integration.id;
}

export async function getIntegrationTools(
  deps: ApiDeps,
  ctx: TenantContext,
  id: string,
): Promise<ToolGrants> {
  const integration = await integrationId(deps, ctx.tenantId, id);
  return { tools: await toolPatterns(ctx.db, await getGrants(ctx.db, integration)) };
}

/** Replace the integration's grants; each pattern must name a server, and a single tool an enabled one. */
export async function setIntegrationTools(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  id: string,
  request: ToolGrants,
): Promise<ToolGrants> {
  const integration = await integrationId(deps, ctx.tenantId, id);
  const tools = await ctx.db.transaction(async (tx) => {
    await setGrants(tx, integration, await resolveToolPatterns(tx, request.tools));
    return toolPatterns(tx, await getGrants(tx, integration));
  });
  await audit(deps.control, {
    tenantId: ctx.tenantId,
    actor: principal.actor,
    action: "integration.tools",
    detail: { integrationId: integration, tools: tools.join(" ") },
  });
  return { tools };
}
