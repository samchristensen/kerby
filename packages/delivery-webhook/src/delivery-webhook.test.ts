import { createHmac } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { WireEvent } from "@kerby/delivery";
import { createEgressFetch, type EgressFetch } from "@kerby/egress";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebhookDestination } from "./index.ts";

type Seen = { url: string; headers: IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let server: Server;
let origin: string;

function route(url: string, res: ServerResponse): void {
  switch (url) {
    case "/ok":
      res.end("thanks");
      return;
    case "/gone":
      res.statusCode = 410;
      res.end("unsubscribed");
      return;
    case "/broken":
      res.statusCode = 500;
      res.end("x".repeat(5000));
      return;
    case "/moved":
      res.statusCode = 302;
      res.setHeader("location", "/ok");
      res.end();
      return;
    default:
      res.statusCode = 404;
      res.end();
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
    route(new URL(req.url ?? "/", "http://x").pathname, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const localFetch: EgressFetch = createEgressFetch({ blockedRanges: [], timeoutMs: 5_000 });
const local = createWebhookDestination({ fetch: localFetch, allowLocal: true });
const event: WireEvent = { id: "4b0cbd7e-8a0b-4d0f-9f5e-0e9a4a7c1d11", body: '{"id":"e","v":1}' };
const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

const deliver = (path: string, secrets: readonly string[] = [secret]) =>
  local.deliver({
    config: { kind: "webhook", url: `${origin}${path}` },
    secrets,
    events: [event],
    signal: new AbortController().signal,
  });

/** A receiver's check: the HMAC of `id.timestamp.body` under the decoded secret. */
const expected = (key: string, id: string, timestamp: string, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(key.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;

describe("webhook destination", () => {
  it("signs exactly like the Standard Webhooks reference vector", async () => {
    let headers: Headers | undefined;
    const capture: EgressFetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    };
    const pinned = createWebhookDestination({
      fetch: capture,
      allowLocal: false,
      now: () => 1614265330 * 1000,
    });
    const outcome = await pinned.deliver({
      config: { kind: "webhook", url: "https://example.com/hook" },
      secrets: [secret],
      events: [{ id: "msg_p5jXN8AQM9LWM0D4loKWxJek", body: '{"test": 2432232314}' }],
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ type: "delivered", status: 204, response: null });
    expect(headers?.get("webhook-timestamp")).toBe("1614265330");
    expect(headers?.get("webhook-signature")).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
  });

  it("posts the body as given, with its id, and signs with both secrets after a rotation", async () => {
    const rotated = local.newSecret();
    const outcome = await deliver("/ok", [rotated, secret]);
    expect(outcome).toEqual({ type: "delivered", status: 200, response: "thanks" });
    const request = seen.at(-1);
    expect(request?.body).toBe(event.body);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toBe("Kerby-Webhooks/1");
    expect(request?.headers["webhook-id"]).toBe(event.id);
    const timestamp = String(request?.headers["webhook-timestamp"]);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(5);
    expect(String(request?.headers["webhook-signature"]).split(" ")).toEqual([
      expected(rotated, event.id, timestamp, event.body),
      expected(secret, event.id, timestamp, event.body),
    ]);
  });

  it("makes secrets of 32 random bytes", () => {
    const made = local.newSecret();
    expect(made).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(made.slice(6), "base64")).toHaveLength(32);
    expect(local.newSecret()).not.toBe(made);
  });

  it("reports 410 as gone, and any other status as a failure with the start of the answer", async () => {
    expect(await deliver("/gone")).toEqual({
      type: "gone",
      error: "HTTP 410 Gone",
      status: 410,
      response: "unsubscribed",
    });
    const failed = await deliver("/broken");
    expect(failed).toMatchObject({ type: "failed", error: "HTTP 500", status: 500 });
    expect(failed.response).toBe("x".repeat(1024));
  });

  it("refuses a redirect instead of following it", async () => {
    const outcome = await deliver("/moved?token=secret-token");
    expect(outcome).toMatchObject({ type: "failed", status: null, response: null });
    if (outcome.type !== "failed") throw new Error("expected a failure");
    expect(outcome.error).toMatch(/^redirect: /);
    expect(outcome.error).not.toContain("secret-token");
    expect(outcome.error).not.toContain("/moved");
  });

  it("refuses a private address with the default egress guard, naming the host only", async () => {
    const guarded = createWebhookDestination({ fetch: createEgressFetch(), allowLocal: false });
    const before = seen.length;
    const outcome = await guarded.deliver({
      config: { kind: "webhook", url: `${origin}/ok?token=secret-token` },
      secrets: [secret],
      events: [event],
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ type: "failed", status: null, response: null });
    if (outcome.type !== "failed") throw new Error("expected a failure");
    expect(outcome.error).toMatch(/^blocked_address: /);
    expect(outcome.error).not.toContain("secret-token");
    expect(seen.length).toBe(before);
  });

  it("requires https unless local destinations are allowed", () => {
    const strict = createWebhookDestination({ fetch: localFetch, allowLocal: false });
    expect(strict.check({ kind: "webhook", url: "http://example.com/hook" })).toMatch(/https/);
    expect(strict.check({ kind: "webhook", url: "https://example.com/hook" })).toBeUndefined();
    expect(local.check({ kind: "webhook", url: "http://127.0.0.1:9/hook" })).toBeUndefined();
  });

  it("is a failure, not a throw, when the endpoint does not answer", async () => {
    const outcome = await local.deliver({
      config: { kind: "webhook", url: "http://127.0.0.1:1/hook" },
      secrets: [secret],
      events: [event],
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ type: "failed", status: null });
  });
});
