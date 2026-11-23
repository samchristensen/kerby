import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JudgmentRun, Question } from "@kerby/judgment";
import { afterEach, describe, expect, it } from "vitest";
import { createSystemOneJudgments } from "./index.ts";

type Seen = { url: string; authorization: string | undefined; body: unknown };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

/** Stop listening and drop connections a test left hanging (a request that never gets an answer). */
function closeServer(server: Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  if (server.listening) server.close(() => closed.resolve());
  else closed.resolve();
  server.closeAllConnections();
  return closed.promise;
}

/** A stand-in for api.typesafe.ai: answers every request with `respond`, and records what it was sent. */
async function typesafe(
  respond: (response: ServerResponse, request: IncomingMessage) => void,
): Promise<{ baseUrl: string; seen: Seen[]; close(): Promise<void> }> {
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
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => closeServer(server),
  };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const KEY = "ts-key-0123456789";

const questions: Record<string, Question> = {
  billing: { type: "noul", instructions: "Is this about billing?" },
  tone: {
    type: "choice",
    instructions: "What is the tone?",
    criteria: { angry: "upset", calm: "neutral" },
  },
  urgency: {
    type: "score",
    instructions: "How urgent?",
    criteria: ["can wait", "this week", "today"],
  },
};

const run = (overrides: Partial<JudgmentRun> = {}): JudgmentRun => ({
  model: "typesafe/jev-latest",
  state: "I was charged twice.",
  questions,
  apiKey: KEY,
  signal: new AbortController().signal,
  ...overrides,
});

const wireAnswers = {
  billing: { type: "noul", noul: 0.98 },
  tone: {
    type: "choice",
    choice: "calm",
    confidence: 0.7,
    probabilities: { angry: 0.15, calm: 0.85 },
  },
  urgency: {
    type: "score",
    score: 1.7,
    confidence: 0.55,
    legend: { "0": "can wait", "1": "this week", "2": "today" },
    probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 },
  },
};

describe("System One judgments", () => {
  it("sends the questions as TypeSafe wants them and returns the port's answers", async () => {
    const { baseUrl, seen } = await typesafe((response) =>
      json(response, 200, {
        model: "jev-2026-01",
        answers: wireAnswers,
        usage: { input_tokens: 120, output_tokens: 12 },
      }),
    );
    const outcome = await createSystemOneJudgments("typesafe", { baseUrl }).judge(run());

    expect(seen).toEqual([
      {
        url: "/v1/systemone",
        authorization: `Bearer ${KEY}`,
        body: { model: "jev-latest", state: "I was charged twice.", questions },
      },
    ]);
    expect(outcome).toEqual({
      type: "answered",
      model: "jev-2026-01",
      answers: {
        billing: { type: "noul", probability: 0.98 },
        tone: {
          type: "choice",
          choice: "calm",
          confidence: 0.7,
          probabilities: { angry: 0.15, calm: 0.85 },
        },
        // TypeSafe keys levels by index as text; the port says level i is probabilities[i].
        urgency: { type: "score", score: 1.7, confidence: 0.55, probabilities: [0.1, 0.1, 0.8] },
      },
      usage: { inputTokens: 120, outputTokens: 12 },
    });
  });

  it("keeps probabilities inside 0 to 1 when TypeSafe's arithmetic overshoots", async () => {
    const { baseUrl } = await typesafe((response) =>
      json(response, 200, {
        model: "jev-latest",
        answers: { billing: { type: "noul", noul: 1.0000000002 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const outcome = await createSystemOneJudgments("typesafe", { baseUrl }).judge(
      run({ questions: { billing: questions.billing as Question } }),
    );
    expect(outcome).toMatchObject({ answers: { billing: { probability: 1 } } });
  });

  it("refuses without asking when the model is not TypeSafe's or no key came", async () => {
    const { baseUrl, seen } = await typesafe((response) => json(response, 200, {}));
    const typesafeJudgments = createSystemOneJudgments("typesafe", { baseUrl });
    expect(await typesafeJudgments.judge(run({ model: "openai/gpt" }))).toMatchObject({
      type: "refused",
      error: expect.stringContaining("typesafe/<model>"),
    });
    const { apiKey: _key, ...keyless } = run();
    expect(await typesafeJudgments.judge(keyless)).toEqual({
      type: "refused",
      error: "no TypeSafe API key",
    });
    expect(seen).toEqual([]);
  });

  it("refuses a rejected key or invalid question, and never repeats the key it was sent", async () => {
    const rejected = await typesafe((response) => json(response, 401, { detail: "bad key" }));
    expect(
      await createSystemOneJudgments("typesafe", { baseUrl: rejected.baseUrl }).judge(run()),
    ).toEqual({
      type: "refused",
      error: "TypeSafe rejected the API key",
    });

    // A provider that quotes what it was sent must not hand the key back.
    const invalid = await typesafe((response) =>
      json(response, 422, { detail: [{ msg: `unexpected value for key ${KEY}` }] }),
    );
    const outcome = await createSystemOneJudgments("typesafe", { baseUrl: invalid.baseUrl }).judge(
      run(),
    );
    expect(outcome).toMatchObject({
      type: "refused",
      error: expect.stringContaining("HTTP 422"),
    });
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(JSON.stringify(outcome)).toContain("[redacted]");
  });

  it("throws for what time can fix, so the task retries", async () => {
    for (const status of [429, 408, 409, 500, 503]) {
      const { baseUrl } = await typesafe((response) => json(response, status, { detail: "later" }));
      await expect(createSystemOneJudgments("typesafe", { baseUrl }).judge(run())).rejects.toThrow(
        `HTTP ${status}`,
      );
    }
    // Nothing listening is a transport error: thrown, with the key scrubbed from its message.
    const { baseUrl, close } = await typesafe(() => {});
    await close();
    await expect(createSystemOneJudgments("typesafe", { baseUrl }).judge(run())).rejects.toThrow(
      /TypeSafe request failed/,
    );
  });

  it("gives up on a request that outlives its timeout", async () => {
    const { baseUrl } = await typesafe(() => {
      // never answers
    });
    await expect(
      createSystemOneJudgments("typesafe", { baseUrl, timeoutMs: 50 }).judge(run()),
    ).rejects.toThrow(/TypeSafe request failed/);
  });

  it("does not follow a redirect with the key in tow", async () => {
    const elsewhere = await typesafe((response) => json(response, 200, {}));
    const { baseUrl } = await typesafe((response) => {
      response.writeHead(307, { location: `${elsewhere.baseUrl}/v1/systemone` });
      response.end();
    });
    await expect(createSystemOneJudgments("typesafe", { baseUrl }).judge(run())).rejects.toThrow(
      /TypeSafe request failed/,
    );
    expect(elsewhere.seen).toEqual([]);
  });

  it("throws when TypeSafe answers other questions than were asked", async () => {
    const { baseUrl } = await typesafe((response) =>
      json(response, 200, {
        model: "jev-latest",
        answers: { billing: wireAnswers.billing },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await expect(createSystemOneJudgments("typesafe", { baseUrl }).judge(run())).rejects.toThrow(
      /different set of questions/,
    );

    const swapped = await typesafe((response) =>
      json(response, 200, {
        model: "jev-latest",
        answers: { billing: wireAnswers.tone },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await expect(
      createSystemOneJudgments("typesafe", { baseUrl: swapped.baseUrl }).judge(
        run({ questions: { billing: questions.billing as Question } }),
      ),
    ).rejects.toThrow(/answered question "billing" as choice, not noul/);
  });

  it("serves OpenCode's decision models over the same wire format, with its own label and model prefix", async () => {
    const { baseUrl, seen } = await typesafe((response) =>
      json(response, 200, {
        model: "jev-1.14",
        answers: wireAnswers,
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    );
    const opencode = createSystemOneJudgments("opencode", { baseUrl });
    expect(opencode.id).toBe("opencode");
    const outcome = await opencode.judge(run({ model: "opencode/gpt-6-luna-decision" }));
    expect(outcome).toMatchObject({ type: "answered", usage: { inputTokens: 9, outputTokens: 3 } });
    // The model id is OpenCode's own, without the Kerby provider prefix; the key is the tenant's OpenCode key.
    expect(seen[0]).toMatchObject({
      url: "/v1/systemone",
      authorization: `Bearer ${KEY}`,
      body: { model: "gpt-6-luna-decision" },
    });

    expect(await opencode.judge(run({ model: "typesafe/jev-latest" }))).toEqual({
      type: "refused",
      error: 'model "typesafe/jev-latest" must look like opencode/<model>',
    });
    const rejected = await typesafe((response) => json(response, 401, { detail: "bad key" }));
    expect(
      await createSystemOneJudgments("opencode", { baseUrl: rejected.baseUrl }).judge(
        run({ model: "opencode/jev-1.14" }),
      ),
    ).toEqual({ type: "refused", error: "OpenCode rejected the API key" });
  });
});
