import { MAX_TOOL_SERVERS, MAX_TOOLS_PER_SERVER, type ToolDefinition } from "@kerby/contracts";
import { createTestTenant, type TestTenant } from "@kerby/conversations/testing";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOLS,
  BuiltinToolServerError,
  createToolServer,
  deleteToolServer,
  findToolServer,
  findToolServerById,
  getGrants,
  listConversationTools,
  listServerGrants,
  listToolServers,
  listTools,
  type OfferedTool,
  offeredTools,
  recordSync,
  resolveToolPatterns,
  type SyncOutcome,
  setConversationTools,
  setGrants,
  ToolNotFoundError,
  ToolNotUsableError,
  type ToolRecord,
  type ToolRef,
  ToolServerLimitError,
  ToolServerNotFoundError,
  type ToolServerRecord,
  ToolServerTakenError,
  toolPatterns,
  UnknownToolError,
  uncoveredBy,
  updateTool,
  updateToolServer,
} from "./index.ts";

const definition = (description: string): ToolDefinition => ({
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
});

const listing = (...tools: [string, string][]): SyncOutcome => ({
  tools: tools.map(([name, description]) => ({ name, definition: definition(description) })),
});

const NONE = { kind: "none" } as const;

async function server(tenant: TestTenant, slug: string): Promise<ToolServerRecord> {
  return createToolServer(tenant.db, { slug, url: `https://${slug}.example.com/mcp`, auth: NONE });
}

async function builtin(tenant: TestTenant): Promise<ToolServerRecord> {
  const found = await findToolServer(tenant.db, "kerby");
  if (!found) throw new Error("the kerby server is missing");
  return found;
}

/** A server with `search` and `create` listed and enabled, and `draft` listed but disabled. */
async function github(tenant: TestTenant): Promise<ToolServerRecord> {
  const made = await server(tenant, "github");
  await recordSync(
    tenant.db,
    made.id,
    listing(["search", "Search issues"], ["create", "Create an issue"], ["draft", "Draft one"]),
  );
  await updateTool(tenant.db, made.id, "search", { enabled: true, effect: "read" });
  await updateTool(tenant.db, made.id, "create", { enabled: true });
  return made;
}

async function conversation(tenant: TestTenant): Promise<string> {
  const { rows } = await tenant.db.query<{ id: string }>(
    "insert into conversations (model) values ('m') returning id",
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no conversation made");
  return id;
}

const byName = async (tenant: TestTenant, serverId: string): Promise<Map<string, ToolRecord>> =>
  new Map((await listTools(tenant.db, serverId)).map((tool) => [tool.name, tool]));

describe("tool servers", () => {
  it("has the built-in server first, then the tenant's by slug, with counts of live tools", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    await server(tenant, "acme");
    await recordSync(
      tenant.db,
      gh.id,
      listing(["search", "Search issues v2"], ["create", "Create an issue"]),
    );

    const servers = await listToolServers(tenant.db);
    expect(servers.map((s) => [s.slug, s.kind, s.status])).toEqual([
      ["kerby", "builtin", "ready"],
      ["acme", "mcp", "syncing"],
      ["github", "mcp", "ready"],
    ]);
    expect(servers[0]).toMatchObject({
      url: null,
      toolCount: BUILTIN_TOOLS.length,
      enabledCount: BUILTIN_TOOLS.length,
      driftedCount: 0,
    });
    // `draft` was removed; `search` drifted
    expect(servers[2]).toMatchObject({ toolCount: 2, enabledCount: 2, driftedCount: 1 });
    expect((await findToolServerById(tenant.db, gh.id))?.slug).toBe("github");
    expect(await findToolServerById(tenant.db, "not-a-uuid")).toBeUndefined();
    expect(await findToolServer(tenant.db, "nope")).toBeUndefined();
  });

  it("refuses a taken slug, the reserved one, and more than MAX_TOOL_SERVERS even at once", async () => {
    await using tenant = await createTestTenant();
    await server(tenant, "github");
    await expect(server(tenant, "github")).rejects.toBeInstanceOf(ToolServerTakenError);
    await expect(server(tenant, "kerby")).rejects.toThrow(/Kerby's own server/);
    for (let i = 1; i < MAX_TOOL_SERVERS - 1; i++) await server(tenant, `s${i}`);
    const results = await Promise.allSettled([server(tenant, "last-a"), server(tenant, "last-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(ToolServerLimitError);
    expect((await listToolServers(tenant.db)).length).toBe(MAX_TOOL_SERVERS + 1);
  });

  it("goes back to syncing on a change, keeping its tools; the built-in server cannot change", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const updated = await updateToolServer(tenant.db, gh.id, {
      url: "https://new.example.com/mcp",
      auth: { kind: "header", header: "Authorization" },
    });
    expect(updated).toMatchObject({
      url: "https://new.example.com/mcp",
      auth: { kind: "header", header: "Authorization" },
      status: "syncing",
    });
    const reauthed = await updateToolServer(tenant.db, gh.id, { auth: NONE });
    expect(reauthed).toMatchObject({ url: "https://new.example.com/mcp", auth: NONE });
    expect((await byName(tenant, gh.id)).get("search")?.enabled).toBe(true);

    const kerby = await builtin(tenant);
    await expect(
      updateToolServer(tenant.db, kerby.id, { url: "https://x.example.com" }),
    ).rejects.toBeInstanceOf(BuiltinToolServerError);
    await expect(deleteToolServer(tenant.db, kerby.id)).rejects.toBeInstanceOf(
      BuiltinToolServerError,
    );
    await expect(recordSync(tenant.db, kerby.id, listing())).rejects.toBeInstanceOf(
      BuiltinToolServerError,
    );
    await expect(
      updateTool(tenant.db, kerby.id, "echo", { enabled: false }),
    ).rejects.toBeInstanceOf(BuiltinToolServerError);
    await expect(
      updateToolServer(tenant.db, crypto.randomUUID(), { url: "https://x.example.com" }),
    ).rejects.toBeInstanceOf(ToolServerNotFoundError);
    expect(await findToolServer(tenant.db, "kerby")).toMatchObject({ kind: "builtin", url: null });
  });

  it("deletes a server with its tools, grants and conversations' uses of it", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const kerby = await builtin(tenant);
    const integration = crypto.randomUUID();
    const id = await conversation(tenant);
    await setGrants(tenant.db, integration, [
      { serverId: gh.id, tool: null },
      { serverId: kerby.id, tool: "echo" },
    ]);
    await setConversationTools(tenant.db, id, [
      { serverId: gh.id, tool: "search" },
      { serverId: kerby.id, tool: null },
    ]);

    expect(await deleteToolServer(tenant.db, gh.id)).toBe(true);
    expect(await deleteToolServer(tenant.db, gh.id)).toBe(false);
    expect(await getGrants(tenant.db, integration)).toEqual([{ serverId: kerby.id, tool: "echo" }]);
    expect(await listConversationTools(tenant.db, id)).toEqual([
      { serverId: kerby.id, tool: null },
    ]);
    expect(await listTools(tenant.db, gh.id)).toEqual([]);
    await expect(recordSync(tenant.db, gh.id, listing())).rejects.toBeInstanceOf(
      ToolServerNotFoundError,
    );

    // the same slug made again is a new server: nothing of the old one carries over
    const again = await server(tenant, "github");
    expect(again.id).not.toBe(gh.id);
    expect(await listServerGrants(tenant.db, again.id)).toEqual([]);
  });
});

describe("syncing a server's tools", () => {
  it("pins new tools disabled, follows the listing while disabled, and keeps an enabled tool's pinned definition", async () => {
    await using tenant = await createTestTenant();
    const gh = await server(tenant, "github");
    await recordSync(tenant.db, gh.id, listing(["search", "v1"], ["create", "v1"]));
    let tools = await byName(tenant, gh.id);
    expect(tools.get("search")).toMatchObject({
      enabled: false,
      effect: "write",
      drifted: false,
      removedAt: null,
      listed: definition("v1"),
      pinned: definition("v1"),
    });
    expect((await findToolServerById(tenant.db, gh.id))?.status).toBe("ready");

    await updateTool(tenant.db, gh.id, "search", { enabled: true });
    await recordSync(tenant.db, gh.id, listing(["search", "v2"], ["create", "v2"]));
    tools = await byName(tenant, gh.id);
    // disabled: follows
    expect(tools.get("create")).toMatchObject({ pinned: definition("v2"), drifted: false });
    // enabled: keeps what an admin enabled, and says it drifted
    expect(tools.get("search")).toMatchObject({
      enabled: true,
      drifted: true,
      listed: definition("v2"),
      pinned: definition("v1"),
    });
    const offered = await offeredTools(tenant.db, [{ serverId: gh.id, tool: null }]);
    expect(offered.map((tool) => [tool.tool, tool.definition.description])).toEqual([
      ["search", "v1"],
    ]);

    // accepting pins what is listed now
    const accepted = await updateTool(tenant.db, gh.id, "search", { acceptDefinition: true });
    expect(accepted).toMatchObject({ pinned: definition("v2"), drifted: false });
    // a listing that comes back to the pinned definition is no longer drift
    await updateTool(tenant.db, gh.id, "create", { enabled: true });
    await recordSync(tenant.db, gh.id, listing(["search", "v2"], ["create", "v3"]));
    await recordSync(tenant.db, gh.id, listing(["search", "v2"], ["create", "v2"]));
    expect((await byName(tenant, gh.id)).get("create")?.drifted).toBe(false);
  });

  it("marks a missing tool removed and not offered; a returning tool keeps its settings", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    await recordSync(tenant.db, gh.id, listing(["create", "Create an issue"]));
    let tools = await byName(tenant, gh.id);
    expect(tools.get("search")?.removedAt).toBeInstanceOf(Date);
    expect(tools.get("draft")?.removedAt).toBeInstanceOf(Date);
    expect(tools.get("create")?.removedAt).toBeNull();
    expect((await offeredTools(tenant.db, "all")).map((tool) => tool.pattern)).toEqual([
      "kerby/echo",
      "kerby/judge",
      "github/create",
    ]);

    await recordSync(
      tenant.db,
      gh.id,
      listing(["create", "Create an issue"], ["search", "Search v2"]),
    );
    tools = await byName(tenant, gh.id);
    expect(tools.get("search")).toMatchObject({
      removedAt: null,
      enabled: true,
      effect: "read",
      drifted: true,
      pinned: definition("Search issues"),
    });
  });

  it("records too many tools, a duplicate name or a refused listing as an error and keeps the tools", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const before = await listTools(tenant.db, gh.id);

    const tooMany = Array.from({ length: MAX_TOOLS_PER_SERVER + 1 }, (_, i): [string, string] => [
      `t${i}`,
      "x",
    ]);
    await recordSync(tenant.db, gh.id, listing(...tooMany));
    expect(await findToolServerById(tenant.db, gh.id)).toMatchObject({
      status: "error",
      lastError: expect.stringMatching(/at most 200 per server/),
    });
    expect(await listTools(tenant.db, gh.id)).toEqual(before);

    await recordSync(tenant.db, gh.id, listing(["search", "a"], ["search", "b"]));
    expect((await findToolServerById(tenant.db, gh.id))?.lastError).toMatch(/twice/);
    await recordSync(tenant.db, gh.id, listing(["has space", "a"]));
    expect((await findToolServerById(tenant.db, gh.id))?.lastError).toMatch(/cannot name it/);
    await recordSync(tenant.db, gh.id, { error: "HTTP 401 from the server" });
    expect(await findToolServerById(tenant.db, gh.id)).toMatchObject({
      status: "error",
      lastError: "HTTP 401 from the server",
    });
    expect(await listTools(tenant.db, gh.id)).toEqual(before);

    await recordSync(tenant.db, gh.id, listing(["search", "Search issues"]));
    expect(await findToolServerById(tenant.db, gh.id)).toMatchObject({
      status: "ready",
      lastError: null,
    });
  });

  it("forgets the oldest removed tools past what a server may keep", async () => {
    await using tenant = await createTestTenant();
    const gh = await server(tenant, "github");
    const first = Array.from({ length: MAX_TOOLS_PER_SERVER }, (_, i): [string, string] => [
      `old${i}`,
      "x",
    ]);
    await recordSync(tenant.db, gh.id, listing(...first));
    await recordSync(tenant.db, gh.id, listing(["new0", "x"], ["new1", "x"]));
    const tools = await listTools(tenant.db, gh.id);
    expect(tools).toHaveLength(MAX_TOOLS_PER_SERVER);
    expect(tools.filter((tool) => tool.removedAt === null).map((tool) => tool.name)).toEqual([
      "new0",
      "new1",
    ]);
  });
});

describe("enabling a tool", () => {
  it("refuses a removed tool, one providers could not call, and an unknown one", async () => {
    await using tenant = await createTestTenant();
    const gh = await server(tenant, "github");
    const long = "a".repeat(60);
    await recordSync(tenant.db, gh.id, listing(["gone", "x"], [long, "x"], ["files.read", "x"]));
    await recordSync(tenant.db, gh.id, listing([long, "x"], ["files.read", "x"]));

    await expect(updateTool(tenant.db, gh.id, "gone", { enabled: true })).rejects.toThrow(
      /no longer lists/,
    );
    await expect(updateTool(tenant.db, gh.id, long, { enabled: true })).rejects.toBeInstanceOf(
      ToolNotUsableError,
    );
    await expect(updateTool(tenant.db, gh.id, "files.read", { enabled: true })).rejects.toThrow(
      /providers refuse/,
    );
    await expect(updateTool(tenant.db, gh.id, "nope", { enabled: true })).rejects.toBeInstanceOf(
      ToolNotFoundError,
    );
    await expect(
      updateTool(tenant.db, crypto.randomUUID(), "gone", { enabled: true }),
    ).rejects.toBeInstanceOf(ToolServerNotFoundError);
    // what is refused is enabling: the effect may still be set
    expect(await updateTool(tenant.db, gh.id, "files.read", { effect: "read" })).toMatchObject({
      effect: "read",
      enabled: false,
    });
  });
});

describe("tool patterns", () => {
  it("resolves servers, tools and Kerby's own tools to ids, each once", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const kerby = await builtin(tenant);
    const refs = await resolveToolPatterns(tenant.db, [
      "github/*",
      "github/search",
      "kerby/judge",
      "kerby/*",
      "github/search",
    ]);
    expect(refs).toEqual([
      { serverId: gh.id, tool: null },
      { serverId: gh.id, tool: "search" },
      { serverId: kerby.id, tool: "judge" },
      { serverId: kerby.id, tool: null },
    ]);
    expect(await toolPatterns(tenant.db, refs)).toEqual([
      "github/*",
      "github/search",
      "kerby/judge",
      "kerby/*",
    ]);
  });

  it("refuses every pattern that names no usable tool, saying why", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    await recordSync(
      tenant.db,
      gh.id,
      listing(["create", "Create an issue"], ["draft", "Draft one"]),
    );
    const error = await resolveToolPatterns(tenant.db, [
      "github/*",
      "nope/*",
      "github/missing",
      "github/search",
      "github/draft",
      "kerby/shell",
      "not a pattern",
    ]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownToolError);
    expect((error as UnknownToolError).problems).toEqual([
      { pattern: "nope/*", reason: "no tool server has that slug" },
      { pattern: "github/missing", reason: "the server lists no tool of that name" },
      { pattern: "github/search", reason: "the server no longer lists it" },
      {
        pattern: "github/draft",
        reason: "not enabled: an admin enables it under the server's tools",
      },
      { pattern: "kerby/shell", reason: "Kerby has no tool of that name" },
      { pattern: "not a pattern", reason: "not <server>/<tool> or <server>/*" },
    ]);
    expect((error as Error).message).toMatch(/github\/draft \(not enabled/);
  });

  it("drops refs to deleted servers when turning refs back into patterns", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const acme = await server(tenant, "acme");
    const refs: ToolRef[] = [
      { serverId: gh.id, tool: "search" },
      { serverId: acme.id, tool: null },
    ];
    await deleteToolServer(tenant.db, acme.id);
    expect(await toolPatterns(tenant.db, refs)).toEqual(["github/search"]);
    expect(await toolPatterns(tenant.db, [{ serverId: "junk", tool: null }])).toEqual([]);
  });
});

describe("grants", () => {
  it("covers a server's tools with a whole-server grant, and one tool only with its own", () => {
    const gh = crypto.randomUUID();
    const kerby = crypto.randomUUID();
    const grants: ToolRef[] = [
      { serverId: gh, tool: "search" },
      { serverId: kerby, tool: null },
    ];
    const wanted: ToolRef[] = [
      { serverId: gh, tool: "search" },
      { serverId: gh, tool: "create" },
      { serverId: gh, tool: null },
      { serverId: kerby, tool: "judge" },
      { serverId: kerby, tool: null },
    ];
    expect(uncoveredBy(grants, wanted)).toEqual([
      { serverId: gh, tool: "create" },
      { serverId: gh, tool: null },
    ]);
    expect(uncoveredBy([{ serverId: gh, tool: null }], wanted)).toEqual([
      { serverId: kerby, tool: "judge" },
      { serverId: kerby, tool: null },
    ]);
    expect(
      uncoveredBy([{ serverId: kerby, tool: "echo" }], [{ serverId: kerby, tool: null }]),
    ).toEqual([{ serverId: kerby, tool: null }]);
  });

  it("replaces an integration's grants and lists who holds a server", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const kerby = await builtin(tenant);
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
    await setGrants(tenant.db, a, [
      { serverId: gh.id, tool: "search" },
      { serverId: kerby.id, tool: null },
      { serverId: gh.id, tool: null },
      { serverId: gh.id, tool: null },
    ]);
    expect(await getGrants(tenant.db, a)).toEqual([
      { serverId: kerby.id, tool: null },
      { serverId: gh.id, tool: null },
      { serverId: gh.id, tool: "search" },
    ]);
    await tenant.db.transaction((tx) => setGrants(tx, b, [{ serverId: gh.id, tool: "create" }]));
    await setGrants(tenant.db, a, [{ serverId: gh.id, tool: "search" }]);
    expect(await getGrants(tenant.db, a)).toEqual([{ serverId: gh.id, tool: "search" }]);
    expect(
      (await listServerGrants(tenant.db, gh.id)).sort((x, y) =>
        x.integrationId.localeCompare(y.integrationId),
      ),
    ).toEqual(
      [
        { integrationId: a, tool: "search" },
        { integrationId: b, tool: "create" },
      ].sort((x, y) => x.integrationId.localeCompare(y.integrationId)),
    );
    expect(await getGrants(tenant.db, "not-a-uuid")).toEqual([]);
    await setGrants(tenant.db, a, []);
    expect(await getGrants(tenant.db, a)).toEqual([]);
  });
});

describe("a conversation's tools", () => {
  it("keeps the named tools in order, and offers only enabled, live tools with their pinned definitions", async () => {
    await using tenant = await createTestTenant();
    const gh = await github(tenant);
    const kerby = await builtin(tenant);
    const id = await conversation(tenant);
    const refs = await resolveToolPatterns(tenant.db, ["kerby/echo", "github/*"]);
    await setConversationTools(tenant.db, id, refs);
    expect(await listConversationTools(tenant.db, id)).toEqual(refs);

    const offered: OfferedTool[] = await offeredTools(
      tenant.db,
      await listConversationTools(tenant.db, id),
    );
    expect(offered.map((tool) => [tool.exposedName, tool.pattern, tool.effect])).toEqual([
      ["kerby__echo", "kerby/echo", "read"],
      ["github__create", "github/create", "write"],
      ["github__search", "github/search", "read"],
    ]);
    expect(offered[1]).toMatchObject({
      tool: "create",
      definition: definition("Create an issue"),
      server: {
        id: gh.id,
        slug: "github",
        kind: "mcp",
        url: "https://github.example.com/mcp",
        auth: NONE,
      },
    });
    expect(offered[0]?.server).toMatchObject({ id: kerby.id, kind: "builtin", url: null });

    // a tool disabled later is no longer offered under `github/*`; one named alone is offered while enabled
    await updateTool(tenant.db, gh.id, "create", { enabled: false });
    await setConversationTools(tenant.db, id, [
      { serverId: gh.id, tool: "search" },
      { serverId: gh.id, tool: "create" },
      { serverId: kerby.id, tool: null },
    ]);
    expect(
      (await offeredTools(tenant.db, await listConversationTools(tenant.db, id))).map(
        (t) => t.pattern,
      ),
    ).toEqual(["kerby/echo", "kerby/judge", "github/search"]);
    expect(await offeredTools(tenant.db, [])).toEqual([]);
    expect(await listConversationTools(tenant.db, crypto.randomUUID())).toEqual([]);
  });

  it("lists Kerby's own tools as enabled read tools of the built-in server", async () => {
    await using tenant = await createTestTenant();
    const kerby = await builtin(tenant);
    expect(
      (await listTools(tenant.db, kerby.id)).map((tool) => [tool.name, tool.enabled, tool.effect]),
    ).toEqual(BUILTIN_TOOLS.map((tool) => [tool.name, true, "read"]));
  });
});
