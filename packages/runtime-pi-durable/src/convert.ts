// Conversion between Kerby's harness-neutral messages and Pi's (ADR 0003). Everything Pi-specific that must
// survive a round trip but means nothing to Kerby (thinking blocks and signatures, provider, api, timestamps)
// rides in `AgentMessage.native` for assistant messages, which this adapter alone reads back.
import type {
  AssistantMessage,
  ImageContent,
  ToolCall as PiToolCall,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ContentPart, ToolCall, ToolResult, Usage } from "@kerby/agent";

type PiAssistantContent = AssistantMessage["content"];
type PiMedia = TextContent | ImageContent;

export type BlobReader = (blobId: string) => Promise<Uint8Array>;

/** A Kerby content part as Pi content. Images are inlined (Pi has no blob store); other blobs become a note. */
export async function toPiMedia(
  parts: readonly ContentPart[],
  readBlob: BlobReader,
): Promise<PiMedia[]> {
  const out: PiMedia[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
    else if (part.mediaType.startsWith("image/")) {
      const bytes = await readBlob(part.blobId);
      out.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: part.mediaType,
      });
    } else out.push({ type: "text", text: `[attachment ${part.blobId}: ${part.mediaType}]` });
  }
  return out;
}

export function textOf(parts: readonly ContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : `[${part.mediaType}]`)).join("");
}

/** A Pi tool call's arguments are a JSON object; Kerby's `input` is whatever the model sent, which is that. */
function toPiToolCall(call: ToolCall): PiToolCall {
  const input = call.input;
  const arguments_ =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as PiToolCall["arguments"])
      : {};
  return { type: "toolCall", id: call.id, name: call.name, arguments: arguments_ };
}

function isPiAssistant(native: unknown): native is AssistantMessage {
  return (
    typeof native === "object" &&
    native !== null &&
    "role" in native &&
    native.role === "assistant" &&
    "content" in native &&
    Array.isArray(native.content) &&
    "api" in native &&
    typeof native.api === "string"
  );
}

const PI_STOP = { end: "stop", tool_use: "toolUse", length: "length" } as const;

export type ModelIdentity = { api: string; provider: string; modelId: string };

export async function userToPi(
  message: Extract<AgentMessage, { role: "user" }>,
  readBlob: BlobReader,
  now: number,
): Promise<UserMessage> {
  return { role: "user", content: await toPiMedia(message.content, readBlob), timestamp: now };
}

/** An assistant message as Pi history: the adapter's own `native` when present, else rebuilt from the neutral form. */
export function assistantToPi(
  message: Extract<AgentMessage, { role: "assistant" }>,
  identity: ModelIdentity,
  now: number,
): AssistantMessage {
  if (isPiAssistant(message.native)) return message.native;
  const content: PiAssistantContent = message.content.map((part) =>
    part.type === "tool_call"
      ? toPiToolCall(part)
      : part.type === "text"
        ? ({ type: "text", text: part.text } satisfies TextContent)
        : ({
            type: "text",
            text: `[attachment ${part.blobId}: ${part.mediaType}]`,
          } satisfies TextContent),
  );
  return {
    role: "assistant",
    content,
    api: identity.api,
    provider: identity.provider,
    model: identity.modelId,
    usage: {
      input: message.usage?.inputTokens ?? 0,
      output: message.usage?.outputTokens ?? 0,
      cacheRead: message.usage?.cacheReadTokens ?? 0,
      cacheWrite: message.usage?.cacheWriteTokens ?? 0,
      totalTokens: (message.usage?.inputTokens ?? 0) + (message.usage?.outputTokens ?? 0),
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: message.usage?.costUsd ?? 0,
      },
    },
    stopReason: PI_STOP[message.stopReason],
    timestamp: now,
  };
}

export async function toolToPi(
  message: Extract<AgentMessage, { role: "tool" }>,
  toolName: string,
  readBlob: BlobReader,
  now: number,
): Promise<ToolResultMessage> {
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName,
    content: await toPiMedia(message.content, readBlob),
    isError: message.isError,
    timestamp: now,
  };
}

function usageOf(message: AssistantMessage): Usage {
  return {
    inputTokens: message.usage.input,
    outputTokens: message.usage.output,
    cacheReadTokens: message.usage.cacheRead,
    cacheWriteTokens: message.usage.cacheWrite,
    costUsd: message.usage.cost.total,
  };
}

/** Pi stop reasons that make a complete, persistable message. Errors, aborts and partials are not messages. */
const KERBY_STOP: Partial<Record<AssistantMessage["stopReason"], "end" | "tool_use" | "length">> = {
  stop: "end",
  toolUse: "tool_use",
  length: "length",
};

/** A finished Pi assistant message as a Kerby message; undefined when it is not one to persist (error, aborted). */
export function assistantFromPi(
  message: AssistantMessage,
  kerbyModel: string,
): AgentMessage | undefined {
  const stopReason = KERBY_STOP[message.stopReason];
  if (!stopReason) return undefined;
  const content: Extract<AgentMessage, { role: "assistant" }>["content"] = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "toolCall")
      content.push({ type: "tool_call", id: block.id, name: block.name, input: block.arguments });
    // Thinking blocks stay in `native`: they are not content a client or another harness may use.
  }
  return {
    role: "assistant",
    content,
    model: kerbyModel,
    stopReason,
    usage: usageOf(message),
    native: message,
  };
}

/** The text of a Pi tool result message (images become a note: bytes never enter Kerby's transcript inline). */
function piMediaToParts(content: readonly PiMedia[]): ContentPart[] {
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "text", text: `[${part.mimeType} image]` },
  );
}

/**
 * A finished Pi tool result as a Kerby message. When Kerby's own `executeTool` result is at hand and the call
 * succeeded, its content wins: it keeps blob references where Pi's copy has bytes inlined.
 */
export function toolFromPi(message: ToolResultMessage, own: ToolResult | undefined): AgentMessage {
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    content: own && !message.isError ? own.content : piMediaToParts(message.content),
    isError: message.isError,
  };
}

/** What a Pi tool result says, as a Kerby tool result (for `tool_end` when Kerby has no result of its own). */
export function toolResultFromPi(message: ToolResultMessage): ToolResult {
  return { content: piMediaToParts(message.content), isError: message.isError };
}
