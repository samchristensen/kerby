// A server-sent-events reader over a fetch body (the WHATWG event stream format, as the API writes it).

export type SseMessage = { id: string | undefined; event: string | undefined; data: string };

/** Yield each event of `body` that carries data; comments (`: keep-alive`) are skipped. Ends when the body ends. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseMessage | undefined => {
    const message =
      data.length > 0 ? ({ id, event, data: data.join("\n") } satisfies SseMessage) : undefined;
    // The API gives only persisted messages an id (their `seq`); a live event after one must not inherit it.
    id = undefined;
    event = undefined;
    data = [];
    return message;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r\n|\n|\r/);
      while (newline !== -1) {
        const lineEnd = buffer[newline] === "\r" && buffer[newline + 1] === "\n" ? 2 : 1;
        // A lone trailing "\r" may be the first half of "\r\n": wait for more.
        if (buffer[newline] === "\r" && newline + 1 === buffer.length) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + lineEnd);
        if (line === "") {
          const message = flush();
          if (message) yield message;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") data.push(value);
          else if (field === "event") event = value;
          else if (field === "id") id = value;
        }
        newline = buffer.search(/\r\n|\n|\r/);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
