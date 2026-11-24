// Behavior of the SDK's own logic (retries, error mapping, validation, waiting, reconnecting) against a stub HTTP
// server that speaks the API's wire format. The SDK against the real API is `make sdk-e2e`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  isKerbyApiError,
  Kerby,
  KerbyApiError,
  KerbyJudgmentError,
  KerbyResponseError,
  KerbyTimeoutError,
  KerbyTurnError,
} from "./index.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Handler = (request: Seen, response: ServerResponse, attempt: number) => void;

/** A server that records each request and lets the test answer it; `attempt` counts requests to the same route. */
async function stub(handler: Handler) {
  const seen: Seen[] = [];
  const attempts = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(entry);
      const key = `${entry.method} ${entry.url.split("?")[0]}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      handler(entry, response, attempt);
    });
  });
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

const reply = (response: ServerResponse, status: number, body: unknown, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const CONVERSATION_ID = "0b5c1f0e-9a3e-4d5b-8f55-3f2f0c2d7a11";
const NOW = "2026-01-01T00:00:00.000Z";
const conversation = {
  id: CONVERSATION_ID,
  externalUserId: null,
  integrationId: null,
  model: "fake/fake-1",
  system: "",
  title: null,
  createdAt: NOW,
  updatedAt: NOW,
  guardrails: [],
  prompt: null,
  tools: [],
};

const page = (messages: unknown[], state: { busy: boolean; lastError?: string | null }) => ({
  conversation,
  messages,
  nextAfter: null,
  busy: state.busy,
  lastError: state.lastError ?? null,
});
const assistantMessage = (seq: number, text: string) => ({
  seq,
  createdAt: NOW,
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "fake/fake-1",
    stopReason: "end",
  },
});

describe("requests", () => {
  it("sends the key as a bearer token and maps an API error to its stable code", async () => {
    const { baseUrl, seen } = await stub((_request, response) =>
      reply(response, 404, { error: { code: "not_found", message: "conversation not found" } }),
    );
    const kerby = new Kerby({ apiKey: "kb_secret", baseUrl });
    const error = await kerby.conversations.get(CONVERSATION_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KerbyApiError);
    expect(isKerbyApiError(error, "not_found")).toBe(true);
    expect(error).toMatchObject({ status: 404, code: "not_found", method: "GET" });
    expect(seen[0]?.headers.authorization).toBe("Bearer kb_secret");
  });

  it("keeps a proxy's non-JSON error page as the message and the status as the code", async () => {
    const { baseUrl } = await stub((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>Bad gateway</html>");
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl, maxRetries: 0 });
    await expect(kerby.conversations.list()).rejects.toMatchObject({
      status: 502,
      code: "http_502",
      message: "<html>Bad gateway</html>",
    });
  });

  it("retries a GET on 503 but never a POST, and retries any request refused with 429", async () => {
    const { baseUrl, seen } = await stub((request, response, attempt) => {
      if (request.url === "/v1/conversations" && request.method === "GET")
        return attempt < 3
          ? reply(response, 503, { error: { code: "unavailable", message: "later" } })
          : reply(response, 200, { conversations: [], nextCursor: null });
      if (request.url === "/v1/judgments")
        return reply(response, 503, { error: { code: "unavailable", message: "later" } });
      // POST /v1/conversations: refused once with 429, then created.
      return attempt === 1
        ? reply(
            response,
            429,
            { error: { code: "rate_limited", message: "slow" } },
            { "retry-after": "0" },
          )
        : reply(response, 201, conversation);
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl, maxRetries: 2 });

    await expect(kerby.conversations.list()).resolves.toEqual({
      conversations: [],
      nextCursor: null,
    });
    expect(seen.filter((r) => r.method === "GET")).toHaveLength(3);

    await expect(
      kerby.judgments.submit({ state: {}, questions: { q: { type: "noul", instructions: "?" } } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(seen.filter((r) => r.url === "/v1/judgments")).toHaveLength(1);

    await expect(kerby.conversations.create()).resolves.toMatchObject({ id: CONVERSATION_ID });
    expect(seen.filter((r) => r.method === "POST" && r.url === "/v1/conversations")).toHaveLength(
      2,
    );
  });

  it("does not sleep through a Retry-After longer than 30 s: the caller gets the 429 with the wait", async () => {
    const { baseUrl, seen } = await stub((_request, response) =>
      reply(
        response,
        429,
        { error: { code: "rate_limited", message: "slow" } },
        { "retry-after": "120" },
      ),
    );
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    await expect(kerby.conversations.list()).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
    });
    expect(seen).toHaveLength(1);
  });

  it("rejects a 2xx body that breaks the contract, unless validation is off", async () => {
    const { baseUrl } = await stub((_request, response) =>
      reply(response, 201, { ...conversation, id: "not-a-uuid" }),
    );
    const strict = new Kerby({ apiKey: "k", baseUrl });
    await expect(strict.conversations.create()).rejects.toBeInstanceOf(KerbyResponseError);
    const lax = new Kerby({ apiKey: "k", baseUrl, validateResponses: false });
    await expect(lax.conversations.create()).resolves.toMatchObject({ id: "not-a-uuid" });
  });

  it("hands the caller's own abort reason back, and turns a time limit into KerbyTimeoutError", async () => {
    const { baseUrl } = await stub(() => {
      // never answers
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl, timeoutMs: 100, maxRetries: 0 });
    await expect(kerby.conversations.list()).rejects.toBeInstanceOf(KerbyTimeoutError);
    const controller = new AbortController();
    const pending = kerby.conversations.list({}, { signal: controller.signal });
    controller.abort(new Error("changed my mind"));
    await expect(pending).rejects.toThrow("changed my mind");
  });
});

describe("conversations.ask", () => {
  it("posts, waits until the turn is no longer busy, and returns the final assistant text and the turn's messages", async () => {
    let polls = 0;
    const { baseUrl, seen } = await stub((request, response) => {
      if (request.method === "POST") return reply(response, 202, { seq: 3 });
      const after = new URL(request.url, "http://x").searchParams.get("after");
      if (after === "3")
        return reply(
          response,
          200,
          page([assistantMessage(4, "thinking"), assistantMessage(5, "The answer.")], {
            busy: false,
          }),
        );
      polls += 1;
      return reply(response, 200, page([], { busy: polls < 3 }));
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const result = await kerby.conversations.ask(CONVERSATION_ID, "question", {
      pollMs: 5,
      maxPollMs: 10,
    });
    expect(result.seq).toBe(3);
    expect(result.text).toBe("The answer.");
    expect(result.messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(polls).toBe(3);
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ content: "question" });
  });

  it("throws KerbyTurnError with the API's reason when the turn ended without an answer", async () => {
    const { baseUrl } = await stub((request, response) =>
      request.method === "POST"
        ? reply(response, 202, { seq: 1 })
        : reply(
            response,
            200,
            page([], { busy: false, lastError: "no model key for provider fake" }),
          ),
    );
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const error = await kerby.conversations
      .ask(CONVERSATION_ID, "hi", { pollMs: 5 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KerbyTurnError);
    expect(error).toMatchObject({
      message: "no model key for provider fake",
      seq: 1,
      conversationId: CONVERSATION_ID,
    });
  });

  it("gives up waiting at timeoutMs with KerbyTimeoutError, leaving the turn to run", async () => {
    const { baseUrl } = await stub((request, response) =>
      request.method === "POST"
        ? reply(response, 202, { seq: 1 })
        : reply(response, 200, page([], { busy: true })),
    );
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    await expect(
      kerby.conversations.ask(CONVERSATION_ID, "hi", { timeoutMs: 60, pollMs: 10, maxPollMs: 20 }),
    ).rejects.toBeInstanceOf(KerbyTimeoutError);
  });
});

const sseFrame = (id: number | undefined, type: string, event: object) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify({
    v: 1,
    conversationId: CONVERSATION_ID,
    runId: "run",
    seq: id ?? 0,
    at: NOW,
    event,
  })}\n\n`;

describe("conversations.stream", () => {
  it("reopens a dropped connection from the last persisted message and carries on", async () => {
    const { baseUrl, seen } = await stub((_request, response, attempt) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": open\n\n");
      if (attempt === 1) {
        response.write(sseFrame(undefined, "text_delta", { type: "text_delta", text: "Hel" }));
        // The connection dies mid-turn, once the frames above have left.
        response.write(
          sseFrame(2, "message_end", {
            type: "message_end",
            message: { role: "user", content: [{ type: "text", text: "hi" }] },
          }),
          () => response.socket?.destroy(),
        );
        return;
      }
      response.write(sseFrame(undefined, "run_end", { type: "run_end", reason: "done" }));
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const types: string[] = [];
    for await (const envelope of kerby.conversations.stream(CONVERSATION_ID, { after: 1 })) {
      types.push(envelope.event.type);
      if (envelope.event.type === "run_end") break;
    }
    expect(types).toEqual(["text_delta", "message_end", "run_end"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers["last-event-id"]).toBe("1");
    expect(seen[1]?.headers["last-event-id"]).toBe("2");
  });

  it("ends quietly when the caller aborts, and does not reconnect", async () => {
    const { baseUrl, seen } = await stub((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": open\n\n");
      response.write(sseFrame(undefined, "text_delta", { type: "text_delta", text: "x" }));
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const controller = new AbortController();
    let count = 0;
    for await (const _ of kerby.conversations.stream(CONVERSATION_ID, {
      signal: controller.signal,
    })) {
      count += 1;
      controller.abort();
    }
    expect(count).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("fails at once on an API error such as a revoked key instead of reconnecting forever", async () => {
    const { baseUrl, seen } = await stub((_request, response) =>
      reply(response, 401, { error: { code: "unauthorized", message: "invalid API key" } }),
    );
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    await expect(kerby.conversations.stream(CONVERSATION_ID).next()).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(seen).toHaveLength(1);
  });
});

describe("events.tail", () => {
  it("long polls from the cursor each page returned, yields only pages with events, and stops on abort", async () => {
    const event = {
      id: "6c1d6f58-6f62-4d0f-8e1a-0d1d0a5a1f01",
      v: 1,
      type: "turn.completed",
      createdAt: NOW,
      integrationId: null,
      data: { conversationId: CONVERSATION_ID, seq: 1, lastSeq: 2 },
    };
    const { baseUrl, seen } = await stub((request, response, attempt) => {
      const after = new URL(request.url, "http://x").searchParams.get("after");
      if (attempt === 1) return reply(response, 200, { events: [], next: "10.0" });
      if (attempt === 2) return reply(response, 200, { events: [event], next: "11.3" });
      return reply(response, 200, { events: [], next: after ?? "" });
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const controller = new AbortController();
    const pages = [];
    for await (const received of kerby.events.tail({
      types: ["turn.*"],
      waitSeconds: 1,
      signal: controller.signal,
    })) {
      pages.push(received);
      controller.abort();
    }
    expect(pages).toHaveLength(1);
    expect(pages[0]?.next).toBe("11.3");
    const afters = seen.map((r) => new URL(r.url, "http://x").searchParams.get("after"));
    expect(afters).toEqual([null, "10.0"]);
    expect(new URL(seen[0]?.url ?? "", "http://x").searchParams.get("types")).toBe("turn.*");
    expect(new URL(seen[0]?.url ?? "", "http://x").searchParams.get("wait")).toBe("1");
  });
});

describe("judgments.judge", () => {
  const JUDGMENT_ID = "9a0e6c3e-5d1f-4c7a-9a55-6b0c8c0d2e22";
  const identity = { id: JUDGMENT_ID, model: "typesafe/jev-latest", createdAt: NOW, prompt: null };
  const request = {
    state: {},
    questions: { ok: { type: "noul" as const, instructions: "Is it ok?" } },
  };

  it("submits, polls until decided and returns the answered judgment", async () => {
    let polls = 0;
    const { baseUrl } = await stub((req, response) => {
      if (req.method === "POST") return reply(response, 202, { id: JUDGMENT_ID });
      polls += 1;
      return reply(
        response,
        200,
        polls < 3
          ? { ...identity, status: "running" }
          : {
              ...identity,
              status: "answered",
              servedModel: "typesafe/jev-1",
              answers: { ok: { type: "noul", probability: 0.9 } },
              usage: { inputTokens: 1, outputTokens: 1 },
            },
      );
    });
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const judgment = await kerby.judgments.judge(request, { pollMs: 5, maxPollMs: 10 });
    expect(judgment.answers.ok).toEqual({ type: "noul", probability: 0.9 });
    expect(polls).toBe(3);
  });

  it("throws KerbyJudgmentError carrying the judgment when the provider refused it", async () => {
    const { baseUrl } = await stub((req, response) =>
      req.method === "POST"
        ? reply(response, 202, { id: JUDGMENT_ID })
        : reply(response, 200, { ...identity, status: "refused", error: "bad key" }),
    );
    const kerby = new Kerby({ apiKey: "k", baseUrl });
    const error = await kerby.judgments.judge(request, { pollMs: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KerbyJudgmentError);
    expect(error).toMatchObject({ judgment: { status: "refused", error: "bad key" } });
  });
});
