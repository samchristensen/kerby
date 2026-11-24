import { describe, expect, it } from "vitest";
import { parseSse, type SseMessage } from "./sse.ts";

const encoder = new TextEncoder();

function body(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseMessage[]> {
  const messages: SseMessage[] = [];
  for await (const message of parseSse(body(chunks))) messages.push(message);
  return messages;
}

describe("parseSse", () => {
  it("reads the API's frames: comments skipped, id and event attached, id not inherited", async () => {
    const messages = await collect([
      ": open\n\n",
      'id: 4\nevent: message_end\ndata: {"a":1}\n\n',
      ": keep-alive\n\n",
      'event: text_delta\ndata: {"b":2}\n\n',
    ]);
    expect(messages).toEqual([
      { id: "4", event: "message_end", data: '{"a":1}' },
      { id: undefined, event: "text_delta", data: '{"b":2}' },
    ]);
  });

  it("reassembles frames split at any byte, including inside a CRLF and a multi-byte character", async () => {
    const frame = "id: 1\r\nevent: e\r\ndata: h\u00e9llo\r\n\r\n";
    const bytes = encoder.encode(frame);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const messages: SseMessage[] = [];
    for await (const message of parseSse(chunks)) messages.push(message);
    expect(messages).toEqual([{ id: "1", event: "e", data: "h\u00e9llo" }]);
  });

  it("joins several data lines with a newline and drops a frame with no data", async () => {
    const messages = await collect(["data: a\ndata: b\n\n", "event: nothing\n\n", "data:c\n\n"]);
    expect(messages.map((message) => message.data)).toEqual(["a\nb", "c"]);
  });

  it("does not emit a frame the connection cut before its blank line", async () => {
    expect(await collect(['data: {"complete":true}\n\n', 'data: {"cut'])).toHaveLength(1);
  });
});
