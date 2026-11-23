/** No server with that slug or id. */
export class ToolServerNotFoundError extends Error {
  override name = "ToolServerNotFoundError";
}

/** Another server of the tenant has the slug, or it is `kerby`. */
export class ToolServerTakenError extends Error {
  override name = "ToolServerTakenError";
}

/** The tenant has `MAX_TOOL_SERVERS` servers. */
export class ToolServerLimitError extends Error {
  override name = "ToolServerLimitError";
}

/** The change is to the built-in `kerby` server, which is served from code: it cannot be changed, synced or deleted. */
export class BuiltinToolServerError extends Error {
  override name = "BuiltinToolServerError";
}

/** The server never listed a tool of that name. */
export class ToolNotFoundError extends Error {
  override name = "ToolNotFoundError";
}

/** The tool cannot be enabled: the server no longer lists it, or providers would refuse its name. */
export class ToolNotUsableError extends Error {
  override name = "ToolNotUsableError";
}

/** Patterns that name no usable tool; `problems` says why for each, and the message lists them all. */
export class UnknownToolError extends Error {
  override name = "UnknownToolError";
  readonly problems: readonly { pattern: string; reason: string }[];
  constructor(problems: { pattern: string; reason: string }[]) {
    super(
      `unknown tools: ${problems.map((p) => `${p.pattern} (${p.reason})`).join("; ")}. GET /v1/tools lists the tools you may name`,
    );
    this.problems = problems;
  }
}
