import { McpError } from "./errors.ts";

/** One dispatched server-sent event. `data` is empty for an event without data (a stream's priming event). */
type SseEvent = { data: string };

/**
 * The events of a `text/event-stream` body, in order. An event (or an unterminated line) longer than `maxChars`
 * ends the stream with an McpError. Comments, `event`, `id` and `retry` fields are read and dropped: Kerby does not
 * resume streams. Breaking out of the loop cancels the body.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  maxChars: number,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanned = 0;
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const lf = buffer.indexOf("\n", scanned);
        const cr = buffer.indexOf("\r", scanned);
        const end = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
        if (end === -1) {
          scanned = buffer.length;
          break;
        }
        // A CR at the end of what has arrived may be the first half of CRLF.
        if (end === cr && end === buffer.length - 1 && !done) {
          scanned = end;
          break;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end === cr && buffer[end + 1] === "\n" ? end + 2 : end + 1);
        scanned = 0;
        if (line === "") {
          yield { data: data.join("\n") };
          data = [];
          size = 0;
          continue;
        }
        const colon = line.indexOf(":");
        if (colon === 0) continue;
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== "data") continue;
        const rest = colon === -1 ? "" : line.slice(colon + 1);
        const text = rest.startsWith(" ") ? rest.slice(1) : rest;
        size += text.length + 1;
        data.push(text);
      }
      if (size + buffer.length > maxChars) {
        throw new McpError(
          "protocol",
          `the MCP server sent a server-sent event over ${maxChars} characters`,
        );
      }
      // An event cut off by the end of the stream is dropped, as the SSE standard says.
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
