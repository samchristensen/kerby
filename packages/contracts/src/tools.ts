// Tools (ADR 0019): the tenant's remote MCP servers, the tools each lists, which integrations may use them, and the
// patterns conversations and prompts name them by. A pattern is `<server>/<tool>` or `<server>/*`; the model sees a
// tool as `<server>__<tool>`. The server `kerby` is reserved: Kerby's own tools, served from code.
import { z } from "zod";

/** Remote servers one tenant may register (the built-in `kerby` is not counted). Defaults until pricing. */
export const MAX_TOOL_SERVERS = 20;
/** Tools kept per server from one listing; a server listing more is a sync error. */
export const MAX_TOOLS_PER_SERVER = 200;
/** A tool's input schema as JSON, at most; a listing with a bigger one is a sync error naming the tool. */
const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;
/** Tools offered to one turn, and patterns one conversation or prompt may name. */
export const MAX_CONVERSATION_TOOLS = 64;
/** Patterns one integration may be granted. */
const MAX_TOOL_GRANTS = 200;

/** The reserved server of Kerby's own tools. */
export const BUILTIN_TOOL_SERVER = "kerby";

const SLUG = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** A tool's name as MCP allows it (2025-11-25 and later): 1 to 128 of `A-Z a-z 0-9 _ - .`. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** What every provider accepts as a tool name: the exposed `<server>__<tool>` must match it. */
const EXPOSED_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PATTERN = /^([a-z0-9][a-z0-9-]{0,23})\/(\*|[A-Za-z0-9_.-]{1,128})$/;

/** A server's short name: fixed once made, the first half of every pattern and exposed name. */
export const ToolServerSlugSchema = z
  .string()
  .regex(SLUG, "a server's name is 1 to 24 of a-z, 0-9 and -, starting with a letter or digit");

export const ToolNameSchema = z
  .string()
  .regex(TOOL_NAME, "a tool's name is 1 to 128 of A-Z, a-z, 0-9, _, - and .");

/** `<server>/<tool>` names one tool; `<server>/*` every enabled tool of the server, as it is at each turn. */
export const ToolPatternSchema = z
  .string()
  .regex(PATTERN, "a tool is named <server>/<tool>, or <server>/* for every tool of a server");

/** The tools a conversation or chat prompt names. None named, none offered: tools are never implied. */
export const ToolSelectionSchema = z
  .array(ToolPatternSchema)
  .max(MAX_CONVERSATION_TOOLS)
  .refine((patterns) => new Set(patterns).size === patterns.length, "each tool pattern once");

/** A pattern's parts; `tool` is null for `<server>/*`. Undefined for anything that is not a pattern. */
export function parseToolPattern(
  pattern: string,
): { slug: string; tool: string | null } | undefined {
  const match = PATTERN.exec(pattern);
  if (!match?.[1] || !match[2]) return undefined;
  return { slug: match[1], tool: match[2] === "*" ? null : match[2] };
}

export const toolPattern = (slug: string, tool: string | null): string => `${slug}/${tool ?? "*"}`;

/**
 * The name the model calls a tool by, `<server>__<tool>`, or undefined when providers would refuse it (more than 64
 * characters, or a `.`): such a tool cannot be enabled. The slug has no `_`, so the first `__` splits it back.
 */
export function exposedToolName(slug: string, tool: string): string | undefined {
  const name = `${slug}__${tool}`;
  return EXPOSED_NAME.test(name) ? name : undefined;
}

/** `read`: may run again after a crash. `write`: never repeated; an interrupted call is reported instead. */
const ToolEffectSchema = z.enum(["read", "write"]);
export type ToolEffect = z.infer<typeof ToolEffectSchema>;

/** MCP's tool annotations: hints from the server, never trusted (they only pre-fill the console's choice of effect). */
const ToolAnnotationsSchema = z.looseObject({
  title: z.string().max(200).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

/** What a server lists for a tool, and what the model is shown once an admin enabled it (the pinned copy). */
export const ToolDefinitionSchema = z.object({
  title: z.string().max(200).exactOptional(),
  description: z.string().max(16_000),
  /** JSON Schema of the tool's input, `type: "object"`: at most `MAX_INPUT_SCHEMA_BYTES` as JSON. */
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine(
      (schema) => new TextEncoder().encode(JSON.stringify(schema)).length <= MAX_INPUT_SCHEMA_BYTES,
      `an input schema is at most ${MAX_INPUT_SCHEMA_BYTES / 1024} KiB as JSON: ask the server's owner to shorten it`,
    ),
  annotations: ToolAnnotationsSchema.exactOptional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/** Headers the transport sets itself, or that must not carry a credential. */
const RESERVED_HEADERS: Record<string, true> = {
  accept: true,
  "accept-encoding": true,
  connection: true,
  host: true,
  "keep-alive": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};
const RESERVED_HEADER_PREFIXES = ["content-", "mcp-", "proxy-", "last-event-id"];

export const ToolHeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, "a header name is 1 to 64 token characters")
  .refine((name) => {
    const lower = name.toLowerCase();
    return (
      RESERVED_HEADERS[lower] === undefined &&
      !RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
    );
  }, "that header is set by the transport: use Authorization or a header of the server's own");

/** Space-separated OAuth scopes (RFC 6749 section 3.3): visible ASCII but `"` and `\`, one space between. */
const OAuthScopeSchema = z
  .string()
  .max(1_000)
  .regex(
    /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/,
    "scopes are separated by one space, each of visible ASCII without quotes or backslashes",
  );

/**
 * How Kerby authenticates to a server: not at all, with a credential sent in one header, or with OAuth (MCP's
 * authorization spec), connected once for the whole tenant in the console. `scope` is what to ask for; without it, what
 * the server's challenge or metadata names.
 */
const ToolServerAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("header"), header: ToolHeaderNameSchema }),
  z.object({ kind: z.literal("oauth"), scope: OAuthScopeSchema.exactOptional() }),
]);
export type ToolServerAuth = z.infer<typeof ToolServerAuthSchema>;

/** A header's value, e.g. `Bearer <token>`: printable ASCII (no CR, LF or tab), at most 4 KiB. Never returned. */
const ToolCredentialSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[\x20-\x7E]+$/, "a credential is printable ASCII on one line");

const ToolServerUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2_000)
  .refine((url) => !/^[a-z]+:\/\/[^/]*@/i.test(url), "no credentials in the URL: use a header");

const httpsWithCredential = (request: {
  url?: string | undefined;
  auth?: ToolServerAuth | undefined;
}) =>
  request.auth?.kind !== "header" ||
  request.url === undefined ||
  request.url.startsWith("https://");

/** `POST /v1/tool-servers`: register a remote MCP server; its tools are listed by a worker, then enabled one by one. */
export const CreateToolServerRequestSchema = z
  .object({
    slug: ToolServerSlugSchema.refine(
      (slug) => slug !== BUILTIN_TOOL_SERVER,
      `"${BUILTIN_TOOL_SERVER}" is Kerby's own server`,
    ),
    url: ToolServerUrlSchema,
    auth: ToolServerAuthSchema.default({ kind: "none" }),
    /** Required with `auth.kind: "header"`, refused without it. */
    credential: ToolCredentialSchema.exactOptional(),
  })
  .refine((request) => (request.auth.kind === "header") === (request.credential !== undefined), {
    message: "a header credential goes with auth.kind header, and only with it",
    path: ["credential"],
  })
  .refine(httpsWithCredential, {
    message: "a server with a credential must use https",
    path: ["url"],
  });
export type CreateToolServerRequest = z.infer<typeof CreateToolServerRequestSchema>;

/** `PATCH /v1/tool-servers/:slug`: a new URL or auth; either lists the server's tools again. */
export const UpdateToolServerRequestSchema = z
  .object({
    url: ToolServerUrlSchema.exactOptional(),
    auth: ToolServerAuthSchema.exactOptional(),
    credential: ToolCredentialSchema.exactOptional(),
  })
  .refine(
    (request) => request.url !== undefined || request.auth !== undefined,
    "change url, auth or both",
  )
  .refine(httpsWithCredential, {
    message: "a server with a credential must use https",
    path: ["url"],
  });
export type UpdateToolServerRequest = z.infer<typeof UpdateToolServerRequestSchema>;

/** `PUT /v1/tool-servers/:slug/credential`: replace the header's value (sealed; only a worker can open it). */
export const PutToolCredentialRequestSchema = z.object({ value: ToolCredentialSchema });

/** `POST /v1/tool-servers/:slug/oauth/start`: where to send the person's browser to connect an `oauth` server. */
export const StartToolServerOAuthResponseSchema = z.object({ authorizationUrl: z.url() });
export type StartToolServerOAuthResponse = z.infer<typeof StartToolServerOAuthResponseSchema>;

/**
 * `POST /v1/tool-servers/oauth/callback`: what the authorization server sent back to the console's callback, as it came
 * in its query: `state`, `iss` when present, and either `code` or `error` (with `error_description` as
 * `errorDescription`).
 */
export const FinishToolServerOAuthRequestSchema = z
  .object({
    state: z.string().min(1).max(512),
    iss: z.string().max(2_000).exactOptional(),
    code: z.string().min(1).max(4_096).exactOptional(),
    error: z.string().min(1).max(200).exactOptional(),
    errorDescription: z.string().max(2_000).exactOptional(),
  })
  .refine(
    (request) => (request.code === undefined) !== (request.error === undefined),
    "the authorization server answers with a code or an error",
  );
export type FinishToolServerOAuthRequest = z.infer<typeof FinishToolServerOAuthRequestSchema>;

/** Where the console publishes Kerby's Client ID Metadata Document: its URL is Kerby's OAuth `client_id`. */
export const OAUTH_CLIENT_METADATA_PATH = "/oauth/client-metadata.json";
/** The console page an authorization server sends the person back to. */
const OAUTH_CALLBACK_PATH = "/dashboard/tools/oauth/callback";

/** Kerby as an OAuth client: its client id, its one redirect URI, and its Client ID Metadata Document. */
export type KerbyOAuthClient = {
  clientId: string;
  redirectUri: string;
  metadata: Record<string, unknown>;
};

/**
 * Kerby as an OAuth client of tenants' MCP servers, given the console's public address: its client id (the URL of its
 * Client ID Metadata Document), its one redirect URI, and that document. A public client: no secret, PKCE always.
 */
export function kerbyOAuthClient(consolePublicUrl: string): KerbyOAuthClient {
  const base = consolePublicUrl.replace(/\/+$/, "");
  const clientId = `${base}${OAUTH_CLIENT_METADATA_PATH}`;
  const redirectUri = `${base}${OAUTH_CALLBACK_PATH}`;
  return {
    clientId,
    redirectUri,
    metadata: {
      client_id: clientId,
      client_name: "Kerby",
      client_uri: base,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

/** `PATCH /v1/tool-servers/:slug/tools/:name`. `acceptDefinition` pins what the server lists now. */
export const UpdateToolRequestSchema = z
  .object({
    enabled: z.boolean().exactOptional(),
    effect: ToolEffectSchema.exactOptional(),
    acceptDefinition: z.literal(true).exactOptional(),
    /**
     * The `listedHash` of the tool as the caller was shown it. With `enabled: true` or `acceptDefinition`, the change
     * is refused (409 `definition_changed`) when the server lists another definition now. Without it, no check.
     */
    expectedDefinition: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "expectedDefinition is the listedHash shown: 64 hex characters")
      .exactOptional(),
  })
  .refine(
    (request) =>
      request.enabled !== undefined ||
      request.effect !== undefined ||
      request.acceptDefinition !== undefined,
    "change enabled, effect or acceptDefinition",
  );
export type UpdateToolRequest = z.infer<typeof UpdateToolRequestSchema>;

const Timestamp = z.iso.datetime();

export const ToolSchema = z.object({
  name: z.string(),
  pattern: ToolPatternSchema,
  /** What the model calls it; null when providers would refuse the name, and then it cannot be enabled. */
  exposedName: z.string().nullable(),
  enabled: z.boolean(),
  effect: ToolEffectSchema,
  /** Enabled, and the server now lists a different definition than the pinned one the model sees. */
  drifted: z.boolean(),
  /** The server no longer lists it; it is not offered. */
  removed: z.boolean(),
  /** The pinned definition: what the model sees. */
  definition: ToolDefinitionSchema,
  /** What the server lists now, when that differs from `definition` (only while `drifted`). */
  listed: ToolDefinitionSchema.nullable(),
  /**
   * SHA-256 (hex) of the canonical JSON (keys sorted) of what the server lists now: the definition enabling or accepting
   * approves. Send it back as `expectedDefinition`.
   */
  listedHash: z.string(),
});
export type Tool = z.infer<typeof ToolSchema>;

const ToolServerStatusSchema = z.enum(["syncing", "ready", "error"]);

const ToolServerSummarySchema = z.object({
  slug: ToolServerSlugSchema,
  /** `builtin`: the reserved `kerby` server, served from code; it cannot be changed or deleted. */
  kind: z.enum(["mcp", "builtin"]),
  url: z.string().nullable(),
  auth: ToolServerAuthSchema,
  /** A credential is stored: the header's value, or for `oauth` the tokens of a connection ("connected"). */
  hasCredential: z.boolean(),
  /** `syncing` until a worker has listed its tools; `error` names why the last listing failed in `lastError`. */
  status: ToolServerStatusSchema,
  lastError: z.string().nullable(),
  syncedAt: Timestamp.nullable(),
  toolCount: z.number().int().nonnegative(),
  enabledCount: z.number().int().nonnegative(),
  driftedCount: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ToolServerSummary = z.infer<typeof ToolServerSummarySchema>;

/** `GET /v1/tool-servers/:slug`: the server, every tool it listed, and which integrations may use what of it. */
export const ToolServerSchema = ToolServerSummarySchema.extend({
  tools: z.array(ToolSchema),
  grantedTo: z.array(z.object({ integrationId: z.uuid(), pattern: ToolPatternSchema })),
});
export type ToolServer = z.infer<typeof ToolServerSchema>;

/** `GET /v1/tool-servers`: every server of the tenant, the built-in one first. */
export const ListToolServersResponseSchema = z.object({
  servers: z.array(ToolServerSummarySchema),
});
export type ListToolServersResponse = z.infer<typeof ListToolServersResponseSchema>;

/** `GET`/`PUT /v1/integrations/:id/tools`: the tools an integration may use. `<server>/*` grants the whole server. */
export const ToolGrantsSchema = z.object({
  tools: z
    .array(ToolPatternSchema)
    .max(MAX_TOOL_GRANTS)
    .refine((patterns) => new Set(patterns).size === patterns.length, "each tool pattern once"),
});
export type ToolGrants = z.infer<typeof ToolGrantsSchema>;

/** One tool a caller may name: what `GET /v1/tools` lists. */
const AvailableToolSchema = z.object({
  pattern: ToolPatternSchema,
  exposedName: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  effect: ToolEffectSchema,
});
export type AvailableTool = z.infer<typeof AvailableToolSchema>;

/** `GET /v1/tools`: the enabled tools the caller's integration may use (every one for an admin), by pattern. */
export const ListAvailableToolsResponseSchema = z.object({ tools: z.array(AvailableToolSchema) });
export type ListAvailableToolsResponse = z.infer<typeof ListAvailableToolsResponseSchema>;
