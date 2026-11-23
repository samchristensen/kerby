// The tool registry (ADR 0019): servers, the tools they list, grants and the tools each conversation names. Everything
// refers to a server by id; slugs appear only at the edges (patterns in, patterns out). The model only ever sees a
// `pinned` definition, which an admin enabled or accepted: `recordSync` keeps that true for every listing.
import { createHash } from "node:crypto";
import {
  BUILTIN_TOOL_SERVER,
  exposedToolName,
  MAX_TOOL_SERVERS,
  MAX_TOOLS_PER_SERVER,
  parseToolPattern,
  type ToolDefinition,
  ToolDefinitionSchema,
  type ToolEffect,
  ToolNameSchema,
  type ToolServerAuth,
  toolPattern,
  type UpdateToolRequest,
} from "@kerby/contracts";
import type { TenantDb, TenantQueryable, TenantTx } from "@kerby/db";
import { errorCode } from "@kerby/observability";
import { BUILTIN_TOOLS, builtinTool } from "./builtin.ts";
import {
  BuiltinToolServerError,
  ToolDefinitionChangedError,
  ToolNotFoundError,
  ToolNotUsableError,
  ToolServerLimitError,
  ToolServerNotFoundError,
  ToolServerTakenError,
  UnknownToolError,
} from "./errors.ts";

/** A server (`tool` null: every tool of it that is enabled at each turn) or one tool of it, by id. */
export type ToolRef = { serverId: string; tool: string | null };

type ToolServerKind = "mcp" | "builtin";
type ToolServerStatus = "syncing" | "ready" | "error";

export type ToolServerRecord = {
  id: string;
  slug: string;
  kind: ToolServerKind;
  /** Null for the built-in server only. */
  url: string | null;
  auth: ToolServerAuth;
  status: ToolServerStatus;
  lastError: string | null;
  /** When a listing last succeeded. */
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ToolRecord = {
  serverId: string;
  name: string;
  /** What the server listed last. */
  listed: ToolDefinition;
  /** What the model sees. */
  pinned: ToolDefinition;
  enabled: boolean;
  effect: ToolEffect;
  /** Enabled, and `listed` differs from `pinned`. */
  drifted: boolean;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What a worker found listing a server: its tools, or why it could not list them. */
export type SyncOutcome =
  | { tools: { name: string; definition: ToolDefinition }[] }
  | { error: string };

/** One tool a turn may call, with what the worker needs to call it. */
export type OfferedTool = {
  /** `<slug>__<tool>`: what the model calls it. */
  exposedName: string;
  /** `<slug>/<tool>`. */
  pattern: string;
  tool: string;
  effect: ToolEffect;
  /** The pinned definition. */
  definition: ToolDefinition;
  server: Pick<ToolServerRecord, "id" | "slug" | "kind" | "url" | "auth">;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `last_error` holds a worker's message, possibly quoting the server: bounded so a server cannot fill the row. */
const MAX_ERROR_LENGTH = 2_000;

type ServerRow = {
  id: string;
  slug: string;
  kind: ToolServerKind;
  url: string | null;
  auth: ToolServerAuth["kind"];
  auth_header: string | null;
  auth_scope: string | null;
  status: ToolServerStatus;
  last_error: string | null;
  synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const SERVER_COLUMNS =
  "s.id, s.slug, s.kind, s.url, s.auth, s.auth_header, s.auth_scope, s.status, s.last_error, s.synced_at, s.created_at, s.updated_at";

function authFromRow(row: ServerRow): ToolServerAuth {
  if (row.auth === "header" && row.auth_header !== null)
    return { kind: "header", header: row.auth_header };
  if (row.auth === "oauth")
    return row.auth_scope === null ? { kind: "oauth" } : { kind: "oauth", scope: row.auth_scope };
  return { kind: "none" };
}

/** The `auth`, `auth_header` and `auth_scope` columns of an auth. */
const authColumns = (auth: ToolServerAuth): [string, string | null, string | null] => [
  auth.kind,
  auth.kind === "header" ? auth.header : null,
  auth.kind === "oauth" ? (auth.scope ?? null) : null,
];

function serverFromRow(row: ServerRow): ToolServerRecord {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    url: row.url,
    auth: authFromRow(row),
    status: row.status,
    lastError: row.last_error,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ToolRow = {
  server_id: string;
  name: string;
  listed: ToolDefinition;
  pinned: ToolDefinition;
  enabled: boolean;
  effect: ToolEffect;
  drifted: boolean;
  removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const TOOL_COLUMNS = `t.server_id, t.name, t.listed, t.pinned, t.enabled, t.effect, t.removed_at, t.created_at,
  t.updated_at, (t.enabled and t.listed <> t.pinned) as drifted`;

const toolFromRow = (row: ToolRow): ToolRecord => ({
  serverId: row.server_id,
  name: row.name,
  listed: row.listed,
  pinned: row.pinned,
  enabled: row.enabled,
  effect: row.effect,
  drifted: row.drifted,
  removedAt: row.removed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Run `fn` in a transaction: the caller's, or a new one on `db`. */
const atomically = <T>(db: TenantQueryable, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> =>
  "transaction" in db ? db.transaction(fn) : fn(db);

const BUILTIN_REFUSAL =
  "the kerby server is Kerby's own and served from code: it cannot be changed, synced or deleted";

/** A new remote server, `syncing` until a worker lists its tools. At most `MAX_TOOL_SERVERS` per tenant. */
export async function createToolServer(
  db: TenantQueryable,
  input: { slug: string; url: string; auth: ToolServerAuth },
): Promise<ToolServerRecord> {
  if (input.slug === BUILTIN_TOOL_SERVER)
    throw new ToolServerTakenError(
      `"${BUILTIN_TOOL_SERVER}" is Kerby's own server: choose another slug`,
    );
  return atomically(db, async (tx) => {
    // Creations serialize, so two at once cannot both take the last place under the limit.
    await tx.query("select pg_advisory_xact_lock(hashtext('kerby.tool_servers.create'))");
    const { rows: counted } = await tx.query<{ count: number }>(
      "select count(*)::int as count from tool_servers where kind = 'mcp'",
    );
    if ((counted[0]?.count ?? 0) >= MAX_TOOL_SERVERS)
      throw new ToolServerLimitError(
        `a tenant keeps at most ${MAX_TOOL_SERVERS} tool servers: delete one first`,
      );
    const { rows } = await tx
      .query<ServerRow>(
        `insert into tool_servers as s (slug, kind, url, auth, auth_header, auth_scope)
         values ($1, 'mcp', $2, $3, $4, $5)
         returning ${SERVER_COLUMNS}`,
        [input.slug, input.url, ...authColumns(input.auth)],
      )
      .catch((error: unknown) => {
        throw errorCode(error) === "23505"
          ? new ToolServerTakenError(
              "another server has that slug: choose another, or delete that server first",
            )
          : error;
      });
    return serverFromRow(firstRow(rows));
  });
}

function firstRow<R>(rows: R[]): R {
  const row = rows[0];
  if (row === undefined) throw new Error("a row written in this statement is missing");
  return row;
}

/** Every server with its tool counts (removed tools not counted), the built-in one first, then by slug. */
export async function listToolServers(
  db: TenantQueryable,
): Promise<
  (ToolServerRecord & { toolCount: number; enabledCount: number; driftedCount: number })[]
> {
  const { rows } = await db.query<
    ServerRow & { tool_count: number; enabled_count: number; drifted_count: number }
  >(
    `select ${SERVER_COLUMNS},
            count(t.name) filter (where t.removed_at is null)::int as tool_count,
            count(t.name) filter (where t.removed_at is null and t.enabled)::int as enabled_count,
            count(t.name) filter (where t.removed_at is null and t.enabled and t.listed <> t.pinned)::int as drifted_count
       from tool_servers s left join tools t on t.server_id = s.id
      group by s.id
      order by s.kind = 'builtin' desc, s.slug`,
  );
  return rows.map((row) => {
    // Kerby's own tools have no rows: each is there and needs no enabling.
    const builtin = row.kind === "builtin";
    return {
      ...serverFromRow(row),
      toolCount: builtin ? BUILTIN_TOOLS.length : row.tool_count,
      enabledCount: builtin ? BUILTIN_TOOLS.length : row.enabled_count,
      driftedCount: builtin ? 0 : row.drifted_count,
    };
  });
}

export async function findToolServer(
  db: TenantQueryable,
  slug: string,
): Promise<ToolServerRecord | undefined> {
  const { rows } = await db.query<ServerRow>(
    `select ${SERVER_COLUMNS} from tool_servers s where s.slug = $1`,
    [slug],
  );
  return rows[0] && serverFromRow(rows[0]);
}

/** Undefined for an id that is not a uuid, too. */
export async function findToolServerById(
  db: TenantQueryable,
  id: string,
): Promise<ToolServerRecord | undefined> {
  if (!UUID.test(id)) return undefined;
  const { rows } = await db.query<ServerRow>(
    `select ${SERVER_COLUMNS} from tool_servers s where s.id = $1`,
    [id],
  );
  return rows[0] && serverFromRow(rows[0]);
}

/** Refuse the built-in server, or a server that is not there. */
async function refuseUnchangeable(db: TenantQueryable, id: string): Promise<never> {
  const server = await findToolServerById(db, id);
  if (server?.kind === "builtin") throw new BuiltinToolServerError(BUILTIN_REFUSAL);
  throw new ToolServerNotFoundError(
    "no tool server has that id: list them with GET /v1/tool-servers",
  );
}

/**
 * A new URL or auth. The server is `syncing` again, since what it lists may differ now; its tools keep their settings
 * until a worker lists them. Either change ends any OAuth connection the console began and has not finished. A
 * credential lives in the control plane: the caller drops it there when it no longer applies. Every caller that
 * changes what a listing would use (URL, auth, credential) or asks for a listing calls this, even with no changes:
 * `updated_at` moves (by a millisecond at least), which fences an older listing still running (`recordSync`'s `asOf`).
 */
export async function updateToolServer(
  db: TenantQueryable,
  id: string,
  changes: { url?: string | undefined; auth?: ToolServerAuth | undefined },
): Promise<ToolServerRecord> {
  if (!UUID.test(id)) return refuseUnchangeable(db, id);
  const [auth, header, scope] = changes.auth ? authColumns(changes.auth) : [null, null, null];
  const { rows } = await db.query<ServerRow>(
    `with ended as (
       delete from tool_oauth_flows where server_id = $1 and ($2::text is not null or $3::text is not null)
     )
     update tool_servers s
        set url = coalesce($2, s.url),
            auth = coalesce($3, s.auth),
            auth_header = case when $3::text is null then s.auth_header else $4 end,
            auth_scope = case when $3::text is null then s.auth_scope else $5 end,
            status = 'syncing', last_error = null,
            updated_at = greatest(now(), s.updated_at + interval '1 millisecond')
      where s.id = $1 and s.kind = 'mcp'
      returning ${SERVER_COLUMNS}`,
    [id, changes.url ?? null, auth, header, scope],
  );
  return rows[0] ? serverFromRow(rows[0]) : refuseUnchangeable(db, id);
}

/**
 * Delete a server with its tools, every grant of it and every conversation's use of it. Its credential lives in the
 * control plane: delete it there. False when there is no such server.
 */
export async function deleteToolServer(db: TenantQueryable, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await db.query("delete from tool_servers where id = $1 and kind = 'mcp'", [
    id,
  ]);
  if (rowCount === 1) return true;
  if ((await findToolServerById(db, id))?.kind === "builtin")
    throw new BuiltinToolServerError(BUILTIN_REFUSAL);
  return false;
}

/** Why a listing cannot be kept, or its tools with their definitions parsed (unknown keys dropped). */
function checkListing(
  tools: { name: string; definition: ToolDefinition }[],
): { problem: string } | { tools: { name: string; definition: ToolDefinition }[] } {
  if (tools.length > MAX_TOOLS_PER_SERVER)
    return {
      problem: `the server lists ${tools.length} tools; Kerby keeps at most ${MAX_TOOLS_PER_SERVER} per server: ask its owner to split them across servers`,
    };
  const seen = new Set<string>();
  const parsed: { name: string; definition: ToolDefinition }[] = [];
  for (const tool of tools) {
    const shown = JSON.stringify(tool.name.slice(0, 128));
    if (!ToolNameSchema.safeParse(tool.name).success)
      return {
        problem: `the server lists a tool named ${shown}, which is not 1 to 128 of A-Z, a-z, 0-9, _, - and .: Kerby cannot name it`,
      };
    if (seen.has(tool.name))
      return { problem: `the server lists the tool ${shown} twice: tool names must be unique` };
    seen.add(tool.name);
    const definition = ToolDefinitionSchema.safeParse(tool.definition);
    if (!definition.success)
      return {
        problem: `the server lists the tool ${shown} with an invalid definition: ${definition.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      };
    parsed.push({ name: tool.name, definition: definition.data });
  }
  return { tools: parsed };
}

/**
 * Store what a worker found listing a server, in one transaction (ADR 0019). A new tool arrives disabled, pinned to
 * what was listed; a disabled tool's pinned definition follows the listing; an enabled tool whose definition changed
 * keeps its pinned one (drifted) until an admin accepts the new one; a tool missing from the listing is marked
 * removed, and a removed one that is listed again comes back with its settings. A listing of more than
 * `MAX_TOOLS_PER_SERVER` tools, a duplicate or unnameable tool name, or an invalid definition is stored as an error
 * and leaves the tools as they were. Removed tools past `MAX_TOOLS_PER_SERVER` kept rows are forgotten, oldest first.
 *
 * `asOf` is the server's `updatedAt` when the listing began. When the server's URL, auth or credential changed since
 * (its `updated_at` moved), the listing is stale and nothing is recorded: the change queued a listing of its own, and
 * a slow old one must not overwrite it. False when nothing was recorded for that reason.
 */
export async function recordSync(
  db: TenantDb,
  serverId: string,
  outcome: SyncOutcome,
  asOf?: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updatedAt = await lockServer(tx, serverId);
    // A `Date` holds milliseconds: the row's timestamp was read cut to them, as the worker's was.
    if (asOf !== undefined && updatedAt.getTime() !== asOf.getTime()) return false;
    const checked = "error" in outcome ? { problem: outcome.error } : checkListing(outcome.tools);
    if ("problem" in checked) {
      await tx.query("update tool_servers set status = 'error', last_error = $2 where id = $1", [
        serverId,
        checked.problem.slice(0, MAX_ERROR_LENGTH),
      ]);
      return true;
    }
    await tx.query(
      `insert into tools as t (server_id, name, listed, pinned)
       select $1, l.name, l.definition, l.definition
         from jsonb_to_recordset($2::jsonb) as l (name text, definition jsonb)
       on conflict (server_id, name) do update
          set listed = excluded.listed,
              pinned = case when t.enabled then t.pinned else excluded.listed end,
              removed_at = null,
              updated_at = now()
        where t.listed <> excluded.listed
           or t.removed_at is not null
           or (not t.enabled and t.pinned <> excluded.listed)`,
      [serverId, JSON.stringify(checked.tools)],
    );
    const names = checked.tools.map((tool) => tool.name);
    await tx.query(
      `update tools set removed_at = now(), updated_at = now()
        where server_id = $1 and removed_at is null and name <> all($2::text[])`,
      [serverId, names],
    );
    await tx.query(
      `delete from tools
        where server_id = $1 and removed_at is not null
          and name not in (select name from tools where server_id = $1 and removed_at is not null
                            order by removed_at desc, name limit $2)`,
      [serverId, Math.max(MAX_TOOLS_PER_SERVER - names.length, 0)],
    );
    await tx.query(
      "update tool_servers set status = 'ready', last_error = null, synced_at = now() where id = $1",
      [serverId],
    );
    return true;
  });
}

/** Locks the server's row and returns its `updated_at`. */
async function lockServer(tx: TenantTx, serverId: string): Promise<Date> {
  const { rows } = UUID.test(serverId)
    ? await tx.query<{ kind: ToolServerKind; updated_at: Date }>(
        "select kind, updated_at from tool_servers where id = $1 for update",
        [serverId],
      )
    : { rows: [] };
  const row = rows[0];
  if (row === undefined)
    throw new ToolServerNotFoundError("the tool server was deleted: there is nothing to record");
  if (row.kind === "builtin") throw new BuiltinToolServerError(BUILTIN_REFUSAL);
  return row.updated_at;
}

/**
 * The server's tools by name, removed ones too. The built-in server's tools come from code: enabled, `read`, never
 * drifted or removed.
 */
export async function listTools(db: TenantQueryable, serverId: string): Promise<ToolRecord[]> {
  const server = await findToolServerById(db, serverId);
  if (!server) return [];
  if (server.kind === "builtin")
    return BUILTIN_TOOLS.map((tool) => ({
      serverId,
      name: tool.name,
      listed: tool.definition,
      pinned: tool.definition,
      enabled: true,
      effect: tool.effect,
      drifted: false,
      removedAt: null,
      createdAt: server.createdAt,
      updatedAt: server.createdAt,
    }));
  const { rows } = await db.query<ToolRow>(
    `select ${TOOL_COLUMNS} from tools t where t.server_id = $1 order by t.name`,
    [serverId],
  );
  return rows.map(toolFromRow);
}

/** JSON with every object's keys sorted (by UTF-16 code units) and `undefined` members left out. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, member]) => member !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A tool's `listedHash` (ADR 0019): SHA-256, in hex, of the definition's canonical JSON. */
export function definitionHash(definition: ToolDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

/**
 * Enable or disable a tool, set its effect, or accept what the server lists now. Enabling refuses a removed tool and
 * one whose exposed name providers would refuse. A disabled tool, and one being enabled, is pinned to what was listed,
 * so enabling approves exactly the definition the admin was shown: with `expectedDefinition` (the `definitionHash` of
 * what the admin was shown), enabling or accepting is refused with `ToolDefinitionChangedError` when the server has
 * listed another definition since.
 */
export async function updateTool(
  db: TenantDb,
  serverId: string,
  name: string,
  changes: UpdateToolRequest,
): Promise<ToolRecord> {
  return db.transaction(async (tx) => {
    const server = await findToolServerById(tx, serverId);
    if (!server)
      throw new ToolServerNotFoundError(
        "no tool server has that id: list them with GET /v1/tool-servers",
      );
    if (server.kind === "builtin")
      throw new BuiltinToolServerError(
        "Kerby's own tools need no enabling and their effect is fixed: grant them and name them instead",
      );
    const { rows: locked } = await tx.query<{
      enabled: boolean;
      removed: boolean;
      listed: ToolDefinition;
    }>(
      "select enabled, removed_at is not null as removed, listed from tools where server_id = $1 and name = $2 for update",
      [serverId, name],
    );
    const current = locked[0];
    if (!current)
      throw new ToolNotFoundError(
        "the server has not listed a tool of that name: sync the server, then check the name",
      );
    if (
      (changes.enabled === true || changes.acceptDefinition === true) &&
      changes.expectedDefinition !== undefined &&
      definitionHash(current.listed) !== changes.expectedDefinition
    )
      throw new ToolDefinitionChangedError(
        "the server lists a different definition now: reload and review it",
      );
    if (changes.enabled === true) {
      if (current.removed)
        throw new ToolNotUsableError(
          "the server no longer lists this tool, so it cannot be enabled: sync again once it does",
        );
      if (exposedToolName(server.slug, name) === undefined)
        throw new ToolNotUsableError(
          `the model would call this tool ${server.slug}__${name}, which providers refuse (at most 64 of A-Z, a-z, 0-9, _ and -): it cannot be enabled unless the server renames it`,
        );
    }
    const enabled = changes.enabled ?? current.enabled;
    const repin = changes.acceptDefinition === true || !enabled || !current.enabled;
    const { rows } = await tx.query<ToolRow>(
      `update tools t
          set enabled = $3, effect = coalesce($4, t.effect),
              pinned = case when $5 then t.listed else t.pinned end, updated_at = now()
        where t.server_id = $1 and t.name = $2
        returning ${TOOL_COLUMNS}`,
      [serverId, name, enabled, changes.effect ?? null, repin],
    );
    return toolFromRow(firstRow(rows));
  });
}

/**
 * The refs `patterns` name, in order, each once. Refuses, naming every bad pattern and why: no such server, no such
 * tool, a removed tool, a tool not enabled. `kerby/<name>` must be one of Kerby's own tools; `<server>/*` needs only
 * the server. No patterns: no query (a tenant whose tool tables are not there yet makes conversations without tools).
 */
export async function resolveToolPatterns(
  db: TenantQueryable,
  patterns: string[],
): Promise<ToolRef[]> {
  if (patterns.length === 0) return [];
  const parsed = patterns.map((pattern) => ({ pattern, parts: parseToolPattern(pattern) }));
  const slugs = [...new Set(parsed.flatMap(({ parts }) => (parts ? [parts.slug] : [])))];
  const { rows: servers } = await db.query<{ id: string; slug: string; kind: ToolServerKind }>(
    "select id, slug, kind from tool_servers where slug = any($1::text[])",
    [slugs],
  );
  const { rows: tools } = await db.query<{
    slug: string;
    name: string;
    enabled: boolean;
    removed: boolean;
  }>(
    `select s.slug, t.name, t.enabled, t.removed_at is not null as removed
       from tools t join tool_servers s on s.id = t.server_id
      where s.slug || '/' || t.name = any($1::text[])`,
    [patterns],
  );
  const serverBySlug = new Map(servers.map((server) => [server.slug, server]));
  const toolByPattern = new Map(tools.map((tool) => [toolPattern(tool.slug, tool.name), tool]));
  const refs: ToolRef[] = [];
  const problems: { pattern: string; reason: string }[] = [];
  for (const { pattern, parts } of parsed) {
    const server = parts && serverBySlug.get(parts.slug);
    if (!parts || !server) {
      const reason = parts ? "no tool server has that slug" : "not <server>/<tool> or <server>/*";
      problems.push({ pattern, reason });
      continue;
    }
    const tool = toolByPattern.get(pattern);
    let reason: string | undefined;
    if (parts.tool === null) reason = undefined;
    else if (server.kind === "builtin")
      reason = builtinTool(parts.tool) ? undefined : "Kerby has no tool of that name";
    else if (!tool) reason = "the server lists no tool of that name";
    else if (tool.removed) reason = "the server no longer lists it";
    else if (!tool.enabled) reason = "not enabled: an admin enables it under the server's tools";
    if (reason !== undefined) {
      problems.push({ pattern, reason });
      continue;
    }
    refs.push({ serverId: server.id, tool: parts.tool });
  }
  if (problems.length > 0) throw new UnknownToolError(problems);
  return distinct(refs);
}

/** The refs as patterns, with the servers' slugs now; a ref to a deleted server is dropped. No refs: no query. */
export async function toolPatterns(db: TenantQueryable, refs: ToolRef[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const ids = [...new Set(refs.map((ref) => ref.serverId))].filter((id) => UUID.test(id));
  const { rows } = await db.query<{ id: string; slug: string }>(
    "select id, slug from tool_servers where id = any($1::uuid[])",
    [ids],
  );
  const slugById = new Map(rows.map((row) => [row.id, row.slug]));
  return refs.flatMap((ref) => {
    const slug = slugById.get(ref.serverId);
    return slug === undefined ? [] : [toolPattern(slug, ref.tool)];
  });
}

const refKey = (ref: ToolRef): string => `${ref.serverId}/${ref.tool ?? ""}`;

/** Each ref once, the first time it appears. */
function distinct(refs: ToolRef[]): ToolRef[] {
  const byKey = new Map<string, ToolRef>();
  for (const ref of refs) if (!byKey.has(refKey(ref))) byKey.set(refKey(ref), ref);
  return [...byKey.values()];
}

/**
 * Replace the tools a conversation names, kept in the order given. Atomic; call it in the conversation's transaction.
 * Empty `refs` write nothing (no query): it is called for a new conversation, which names none yet, and that must work
 * on a tenant whose tool tables are not there yet. Do not use it to clear a conversation's tools.
 */
export async function setConversationTools(
  db: TenantQueryable,
  conversationId: string,
  refs: ToolRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const unique = distinct(refs);
  await atomically(db, async (tx) => {
    await tx.query("delete from conversation_tools where conversation_id = $1", [conversationId]);
    await tx.query(
      `insert into conversation_tools (conversation_id, server_id, tool, position)
       select $1, r.server_id, r.tool, r.position::int
         from unnest($2::uuid[], $3::text[]) with ordinality as r (server_id, tool, position)`,
      [conversationId, unique.map((ref) => ref.serverId), unique.map((ref) => ref.tool)],
    );
  });
}

/**
 * The tools a conversation names, in order; none for an unknown conversation, and none on a tenant whose tool tables
 * are not there yet (its tool migration has not run: Postgres 42P01).
 */
export async function listConversationTools(
  db: TenantQueryable,
  conversationId: string,
): Promise<ToolRef[]> {
  if (!UUID.test(conversationId)) return [];
  try {
    const { rows } = await db.query<{ server_id: string; tool: string | null }>(
      "select server_id, tool from conversation_tools where conversation_id = $1 order by position",
      [conversationId],
    );
    return rows.map((row) => ({ serverId: row.server_id, tool: row.tool }));
  } catch (error) {
    if (errorCode(error) === "42P01") return [];
    throw error;
  }
}

/** An integration's grants: the built-in server's first, then by slug, a whole server before its single tools. */
export async function getGrants(db: TenantQueryable, integrationId: string): Promise<ToolRef[]> {
  if (!UUID.test(integrationId)) return [];
  const { rows } = await db.query<{ server_id: string; tool: string | null }>(
    `select g.server_id, g.tool from integration_tools g join tool_servers s on s.id = g.server_id
      where g.integration_id = $1
      order by s.kind = 'builtin' desc, s.slug, g.tool nulls first`,
    [integrationId],
  );
  return rows.map((row) => ({ serverId: row.server_id, tool: row.tool }));
}

/** Replace an integration's grants. Atomic. */
export async function setGrants(
  db: TenantQueryable,
  integrationId: string,
  refs: ToolRef[],
): Promise<void> {
  const unique = distinct(refs);
  await atomically(db, async (tx) => {
    await tx.query("delete from integration_tools where integration_id = $1", [integrationId]);
    await tx.query(
      `insert into integration_tools (integration_id, server_id, tool)
       select $1, r.server_id, r.tool from unnest($2::uuid[], $3::text[]) as r (server_id, tool)`,
      [integrationId, unique.map((ref) => ref.serverId), unique.map((ref) => ref.tool)],
    );
  });
}

/**
 * The refs of `wanted` that `grants` do not cover. A whole-server grant covers the server and each of its tools; a
 * one-tool grant covers that tool only, never `<server>/*`.
 */
export function uncoveredBy(grants: ToolRef[], wanted: ToolRef[]): ToolRef[] {
  const granted = new Set(grants.map(refKey));
  return wanted.filter(
    (ref) =>
      !granted.has(refKey({ serverId: ref.serverId, tool: null })) && !granted.has(refKey(ref)),
  );
}

/** Who holds a grant of the server: whole (`tool` null) or one tool. */
export async function listServerGrants(
  db: TenantQueryable,
  serverId: string,
): Promise<{ integrationId: string; tool: string | null }[]> {
  if (!UUID.test(serverId)) return [];
  const { rows } = await db.query<{ integration_id: string; tool: string | null }>(
    `select integration_id, tool from integration_tools where server_id = $1
      order by integration_id, tool nulls first`,
    [serverId],
  );
  return rows.map((row) => ({ integrationId: row.integration_id, tool: row.tool }));
}

/**
 * The tools `refs` (or every server, for "all") stand for now: enabled, not removed and with a name providers accept,
 * each once with its pinned definition. Built-in refs expand to Kerby's own tools; the caller drops those it cannot
 * run, and applies `MAX_CONVERSATION_TOOLS`. Ordered by server (built-in first, then slug), then tool name. No refs:
 * no query.
 */
export async function offeredTools(
  db: TenantQueryable,
  refs: ToolRef[] | "all",
): Promise<OfferedTool[]> {
  if (refs !== "all" && refs.length === 0) return [];
  const ids =
    refs === "all"
      ? null
      : [...new Set(refs.map((ref) => ref.serverId))].filter((id) => UUID.test(id));
  const { rows: servers } = await db.query<ServerRow>(
    `select ${SERVER_COLUMNS} from tool_servers s
      where $1::uuid[] is null or s.id = any($1::uuid[])
      order by s.kind = 'builtin' desc, s.slug`,
    [ids],
  );
  const { rows: tools } = await db.query<{
    server_id: string;
    name: string;
    pinned: ToolDefinition;
    effect: ToolEffect;
  }>(
    `select t.server_id, t.name, t.pinned, t.effect from tools t
      where t.enabled and t.removed_at is null and t.server_id = any($1::uuid[])
      order by t.server_id, t.name`,
    [servers.map((server) => server.id)],
  );
  const named = new Set(refs === "all" ? [] : refs.map(refKey));
  const offered: OfferedTool[] = [];
  for (const row of servers) {
    const server = serverFromRow(row);
    const whole = refs === "all" || named.has(refKey({ serverId: server.id, tool: null }));
    const candidates =
      server.kind === "builtin"
        ? BUILTIN_TOOLS.map((tool) => ({
            name: tool.name,
            definition: tool.definition,
            effect: tool.effect,
          }))
        : tools
            .filter((tool) => tool.server_id === server.id)
            .map((tool) => ({ name: tool.name, definition: tool.pinned, effect: tool.effect }));
    for (const candidate of candidates) {
      if (!whole && !named.has(refKey({ serverId: server.id, tool: candidate.name }))) continue;
      const exposedName = exposedToolName(server.slug, candidate.name);
      if (exposedName === undefined) continue;
      offered.push({
        exposedName,
        pattern: toolPattern(server.slug, candidate.name),
        tool: candidate.name,
        effect: candidate.effect,
        definition: candidate.definition,
        server: {
          id: server.id,
          slug: server.slug,
          kind: server.kind,
          url: server.url,
          auth: server.auth,
        },
      });
    }
  }
  return offered;
}
