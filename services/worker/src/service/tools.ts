// A turn's tools (ADR 0019): the tools its conversation names that are enabled, not removed and available now, each
// shown to the model with the definition an admin approved (the pinned one). Kerby's own run here; a tenant's remote
// tools through its MCP server, one session per server per run, behind the egress guard.
import type { ContentPart, ToolCall, ToolResult, ToolSpec } from "@kerby/agent";
import {
  DEFAULT_JUDGMENT_MODEL,
  JudgmentRequestSchema,
  MAX_CONVERSATION_TOOLS,
} from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import { EgressError } from "@kerby/egress";
import { type McpCallOutcome, type McpSession, openMcpSession } from "@kerby/mcp";
import { listConversationTools, type OfferedTool, offeredTools } from "@kerby/tools";
import type { WorkerDeps } from "../types/index.ts";
import { type Judge, judgeTool } from "./judgments.ts";
import {
  afterRefusal,
  MCP_CLIENT_INFO,
  type ServerAuth,
  toolServerHeaders,
  whyToolFailed,
} from "./mcp.ts";

/** Text of one tool result the model reads, at most; past it the result is cut with a note. */
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export interface TurnTools {
  /** What the model is offered, by exposed name (`<server>__<tool>`). */
  readonly specs: ToolSpec[];
  /** Whether a call may run again after an attempt that began it never stored a result: `read` tools only. */
  repeatable(name: string): boolean;
  /**
   * Opens what a call needs before it counts as begun: a remote tool's credential and session. A credential that cannot
   * be read throws here, so the retried turn does not take the call for one that began and report a write as interrupted.
   */
  prepare(name: string): Promise<void>;
  /** Runs a call. A failure of the tool or its server is an error result; only a lost run (`signal`) throws. */
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  /** `text` without any tool credential this run opened. */
  scrub(text: string): string;
  /** Ends the run's MCP sessions. Never throws. */
  close(): Promise<void>;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** The message a model reads in place of a write tool's result when an earlier attempt may have run it. */
export const interruptedResult = (name: string): ToolResult =>
  textResult(
    `the call to ${name} was interrupted before its result was stored; it may or may not have taken effect: check before calling it again`,
    true,
  );

function specOf(tool: OfferedTool): ToolSpec {
  const { title, description, inputSchema } = tool.definition;
  return {
    name: tool.exposedName,
    description: title ? `${title}: ${description}` : description,
    inputSchema,
    readOnly: tool.effect === "read",
  };
}

/**
 * The tools of a conversation's turn, or why the turn cannot run with them (more than `MAX_CONVERSATION_TOOLS`: the
 * same answer every time, so the caller ends the turn without a retry). A built-in that is unavailable now (`echo`
 * off, no key for `judge`) is left out.
 */
export async function turnTools(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversationId: string,
): Promise<TurnTools | { refused: string }> {
  const refs = await listConversationTools(ctx.db, conversationId);
  const named = refs.length === 0 ? [] : await offeredTools(ctx.db, refs);
  const judge = named.some((tool) => tool.server.kind === "builtin" && tool.tool === "judge")
    ? await judgeTool(deps, ctx.tenantId, conversationId)
    : undefined;
  const offered = named.filter(
    (tool) =>
      tool.server.kind !== "builtin" ||
      (tool.tool === "echo" && deps.settings.enableEchoTool) ||
      (tool.tool === "judge" && judge !== undefined),
  );
  if (offered.length > MAX_CONVERSATION_TOOLS)
    return {
      refused: `the conversation's tools stand for ${offered.length} tools, more than the ${MAX_CONVERSATION_TOOLS} a turn may be offered: name fewer (a <server>/* pattern takes every enabled tool of the server), then post a message`,
    };
  return runnable(deps, ctx.tenantId, offered, judge);
}

type Opened =
  | { session: McpSession; auth: Exclude<ServerAuth, { missing: string }> }
  | { missing: string };

function runnable(
  deps: WorkerDeps,
  tenantId: string,
  offered: OfferedTool[],
  judge: Judge | undefined,
): TurnTools {
  const byName = new Map(offered.map((tool) => [tool.exposedName, tool]));
  const sessions = new Map<string, Promise<Opened>>();
  const secrets = new Set<string>();
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
    return out;
  };

  /** A session with `auth`'s headers, its secrets kept for scrubbing; or why there is none. */
  function open(server: OfferedTool["server"], auth: ServerAuth): Opened {
    if ("missing" in auth) return auth;
    for (const secret of auth.secrets) secrets.add(secret);
    if (server.url === null) throw new Error(`tool server ${server.slug} has no URL`);
    return {
      session: openMcpSession({
        url: server.url,
        fetch: deps.toolFetch,
        headers: auth.headers,
        clientInfo: MCP_CLIENT_INFO,
      }),
      auth,
    };
  }

  /** Keep `opened` as the server's session for the rest of the run; a failure to open is not kept. */
  function keep(serverId: string, opened: Promise<Opened>): Promise<Opened> {
    opened.catch(() => sessions.delete(serverId));
    sessions.set(serverId, opened);
    return opened;
  }

  /** The server's session for this run, opened on its first call with the server's credential. */
  function sessionFor(server: OfferedTool["server"], signal: AbortSignal): Promise<Opened> {
    return (
      sessions.get(server.id) ??
      keep(
        server.id,
        toolServerHeaders(deps, tenantId, server, signal).then((auth) => open(server, auth)),
      )
    );
  }

  async function callRemote(
    tool: OfferedTool,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const input = call.input;
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return textResult(
        `${tool.exposedName} takes a JSON object as its input (see its input schema), not ${Array.isArray(input) ? "an array" : input === null ? "null" : `a ${typeof input}`}`,
        true,
      );
    const doing = `calling ${tool.exposedName}`;
    let opened = await sessionFor(tool.server, signal);
    // An OAuth server that refuses its token (401, so the call did not run) gets one refresh and one more try.
    for (let attempt = 0; ; attempt++) {
      if ("missing" in opened) return textResult(`${doing} failed: ${opened.missing}`, true);
      try {
        const outcome = await opened.session.callTool(tool.tool, input as Record<string, unknown>, {
          callId: call.id,
          signal: AbortSignal.any([signal, AbortSignal.timeout(deps.settings.toolCallTimeoutMs)]),
          inputSchema: tool.definition.inputSchema,
        });
        return resultOf(outcome, scrub);
      } catch (error) {
        // A lost lease is not the tool's failure: the run that owns the turn now takes it from the stored state.
        if (signal.aborted) throw error;
        const again =
          attempt === 0
            ? afterRefusal(deps, tenantId, tool.server, opened.auth, error, signal)
            : undefined;
        if (again === undefined) {
          const why = whyToolFailed(error, [...secrets], doing, tool.server.auth.kind);
          return textResult(
            tool.effect === "write" && mayHaveTakenEffect(error)
              ? `${why}. The call may have taken effect: check before calling it again.`
              : why,
            true,
          );
        }
        // The refreshed token's session replaces the refused one for the rest of the run.
        const refused = opened.session;
        opened = await keep(
          tool.server.id,
          again.then((auth) => open(tool.server, auth)),
        );
        await refused.close().catch(() => {});
      }
    }
  }

  return {
    specs: offered.map(specOf),
    repeatable: (name) => byName.get(name)?.effect === "read",
    scrub,
    async prepare(name) {
      const tool = byName.get(name);
      if (tool && tool.server.kind !== "builtin") await sessionFor(tool.server);
    },
    async execute(call, signal) {
      const tool = byName.get(call.name);
      if (!tool) return textResult(`unknown tool "${call.name}"`, true);
      if (tool.server.kind === "builtin") return runBuiltin(tool.tool, call, signal, judge);
      return callRemote(tool, call, signal);
    },
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map((opened) =>
          opened.then((o) => ("session" in o ? o.session.close() : undefined)).catch(() => {}),
        ),
      );
    },
  };
}

async function runBuiltin(
  name: string,
  call: ToolCall,
  signal: AbortSignal,
  judge: Judge | undefined,
): Promise<ToolResult> {
  if (name === "echo") {
    const input = call.input;
    const text =
      typeof input === "object" &&
      input !== null &&
      "text" in input &&
      typeof input.text === "string"
        ? input.text
        : undefined;
    return text === undefined ? textResult("echo needs a string `text`", true) : textResult(text);
  }
  if (name === "judge" && judge) {
    // The model wrote this input: parse it as the API parses a tenant's, and say what is wrong so it can retry.
    const parsed = JudgmentRequestSchema.safeParse(call.input);
    if (!parsed.success)
      return textResult(
        `judge input is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        true,
      );
    const outcome = await judge(
      { ...parsed.data, model: parsed.data.model ?? DEFAULT_JUDGMENT_MODEL },
      signal,
      call.id,
    );
    return outcome.type === "answered"
      ? textResult(JSON.stringify(outcome.answers))
      : textResult(outcome.error, true);
  }
  return textResult(`unknown tool "${call.name}"`, true);
}

/** A timeout or a broken connection: the request may have reached the server, and the tool may have run. */
function mayHaveTakenEffect(error: unknown): boolean {
  if (error instanceof EgressError)
    return (
      error.reason === "timeout" ||
      error.reason === "network" ||
      error.reason === "response_too_large"
    );
  if (error instanceof DOMException) return error.name === "TimeoutError";
  // `fetch` itself failing mid-exchange (a reset connection).
  return error instanceof TypeError;
}

/**
 * What the model reads of a call: text parts as they are, `structuredContent` as JSON when there is no text, a note
 * for any other kind of content, at most `MAX_TOOL_RESULT_BYTES` of text in all, without any credential.
 */
function resultOf(outcome: McpCallOutcome, scrub: (text: string) => string): ToolResult {
  const texts: string[] = [];
  for (const part of outcome.content) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else texts.push(`[a ${part.type} part of the result was left out: Kerby passes text only]`);
  }
  if (
    !outcome.content.some((part) => part.type === "text") &&
    outcome.structuredContent !== undefined
  )
    texts.unshift(JSON.stringify(outcome.structuredContent));
  const encoder = new TextEncoder();
  const content: ContentPart[] = [];
  let left = MAX_TOOL_RESULT_BYTES;
  let cut = 0;
  for (const raw of texts) {
    const text = scrub(raw);
    const bytes = encoder.encode(text);
    if (bytes.length <= left) {
      content.push({ type: "text", text });
      left -= bytes.length;
      continue;
    }
    cut += bytes.length - left;
    if (left > 0)
      content.push({
        type: "text",
        // A cut inside a character leaves a replacement character: drop it.
        text: new TextDecoder().decode(bytes.subarray(0, left)).replace(/\uFFFD$/, ""),
      });
    left = 0;
  }
  if (cut > 0)
    content.push({
      type: "text",
      text: `[the result was cut at ${MAX_TOOL_RESULT_BYTES / 1024} KiB: ${cut} more bytes were left out]`,
    });
  return { content, isError: outcome.isError };
}
