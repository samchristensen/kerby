import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EmbeddingRun } from "@kerby/embeddings";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenAiEmbeddings } from "./index.ts";

type Seen = { url: string; authorization: string | undefined; body: unknown };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

function closeServer(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  if (server.listening) server.close(() => closed.resolve());
  else closed.resolve();
  server.closeAllConnections();
  return closed.promise;
}

/** A stand-in for an OpenAI-compatible provider: answers every request with `respond`, and records what it was sent. */
async function provider(
  respond: (response: ServerResponse, request: IncomingMessage) => void,
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
      });
      respond(response, request);
    });
  });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const KEY = "sk-test-0123456789";

const run = (overrides: Partial<EmbeddingRun> = {}): EmbeddingRun => ({
  model: "openai/text-embedding-3-small",
  inputs: ["first", "second"],
  apiKey: KEY,
  signal: new AbortController().signal,
  ...overrides,
});

describe("OpenAI-format embeddings", () => {
  it("sends the wire request and maps vectors in index order with usage", async () => {
    const server = await provider((response) =>
      json(response, 200, {
        object: "list",
        model: "text-embedding-3-small",
        data: [
          { object: "embedding", index: 1, embedding: [0, 1] },
          { object: "embedding", index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    );
    const outcome = await createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl }).embed(
      run(),
    );
    expect(outcome).toEqual({
      type: "embedded",
      model: "openai/text-embedding-3-small",
      vectors: [
        [1, 0],
        [0, 1],
      ],
      usage: { inputTokens: 7 },
    });
    expect(server.seen).toEqual([
      {
        url: "/v1/embeddings",
        authorization: `Bearer ${KEY}`,
        body: {
          model: "text-embedding-3-small",
          input: ["first", "second"],
          encoding_format: "float",
        },
      },
    ]);
  });

  it("refuses on 401 without the key in the error", async () => {
    const server = await provider((response) =>
      json(response, 401, { error: { message: `Incorrect API key provided: ${KEY}.\nCheck it.` } }),
    );
    const outcome = await createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl }).embed(
      run(),
    );
    expect(outcome.type).toBe("refused");
    if (outcome.type !== "refused") return;
    expect(outcome.error).not.toContain(KEY);
    expect(outcome.error).toContain("Incorrect API key provided");
    expect(outcome.error).not.toContain("\n");
  });

  it.each([429, 500])("throws on HTTP %i so the task retries", async (status) => {
    const server = await provider((response) =>
      json(response, status, { error: { message: "busy" } }),
    );
    await expect(
      createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl }).embed(run()),
    ).rejects.toThrow(String(status));
  });

  it.each([
    ["a malformed body", { data: "nope" }],
    ["too few vectors", { data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } }],
    [
      "vectors of different lengths",
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 1, embedding: [1] },
        ],
      },
    ],
  ])("throws on %s", async (_, body) => {
    const server = await provider((response) => json(response, 200, body));
    await expect(
      createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl }).embed(run()),
    ).rejects.toThrow();
  });

  it("throws on timeout", async () => {
    const server = await provider(() => {});
    await expect(
      createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl, timeoutMs: 100 }).embed(run()),
    ).rejects.toThrow(/request failed/);
  });

  it("does not follow a redirect", async () => {
    const server = await provider((response) => {
      response.writeHead(307, { location: "http://127.0.0.1:1/elsewhere" });
      response.end();
    });
    await expect(
      createOpenAiEmbeddings("openai", { baseUrl: server.baseUrl }).embed(run()),
    ).rejects.toThrow(/request failed/);
    expect(server.seen).toHaveLength(1);
  });

  it("refuses another provider's model and oversized batches without calling out", async () => {
    const server = await provider((response) => json(response, 500, {}));
    const embeddings = createOpenAiEmbeddings("mistral", { baseUrl: server.baseUrl });
    expect(await embeddings.embed(run())).toMatchObject({ type: "refused" });
    expect(
      await embeddings.embed(
        run({ model: "mistral/mistral-embed", inputs: new Array(97).fill("x") }),
      ),
    ).toMatchObject({ type: "refused" });
    expect(server.seen).toHaveLength(0);
  });
});
