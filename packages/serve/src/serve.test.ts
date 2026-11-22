import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bearerToken,
  createRouter,
  HttpError,
  json,
  readJson,
  type Server,
  serve,
} from "./index.ts";

// A collection mid-stream is what lost the abort in CI; force one where it matters.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(routes: Parameters<typeof createRouter>[0]) {
  const server = await serve(createRouter(routes), { host: "127.0.0.1", port: 0 });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("router", () => {
  it("hands a route the connection's peer address, never a header's", async () => {
    const base = await start([
      ["GET", "/who", (_req, _params, client) => json(200, { address: client.address })],
    ]);
    const response = await fetch(`${base}/who`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(await response.json()).toEqual({ address: "127.0.0.1" });
  });

  it("matches methods and path params, and answers 404 and 405", async () => {
    const base = await start([
      ["GET", "/v1/things/:id", (_req, params) => json(200, { id: params.id })],
      ["POST", "/v1/things/:id", () => json(201, {})],
    ]);
    expect(await (await fetch(`${base}/v1/things/a%20b`)).json()).toEqual({ id: "a b" });
    expect((await fetch(`${base}/v1/things/x`, { method: "POST" })).status).toBe(201);
    expect((await fetch(`${base}/v1/things/x`, { method: "DELETE" })).status).toBe(405);
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });

  it("turns HttpError into its status and hides other errors", async () => {
    const base = await start([
      [
        "GET",
        "/teapot",
        () => {
          throw new HttpError(418, "teapot", "short and stout");
        },
      ],
      [
        "GET",
        "/boom",
        () => {
          throw new Error("secret detail");
        },
      ],
    ]);
    const teapot = await fetch(`${base}/teapot`);
    expect(teapot.status).toBe(418);
    expect(await teapot.json()).toEqual({ error: { code: "teapot", message: "short and stout" } });
    const boom = await fetch(`${base}/boom`);
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("secret detail");
  });
});

describe("readJson", () => {
  const schema = z.object({ name: z.string().min(3) });
  it("returns the parsed body, or a 400 that names keys and not values", async () => {
    const base = await start([
      ["POST", "/x", async (req) => json(200, await readJson(req, schema))],
    ]);
    const post = (body: string) => fetch(`${base}/x`, { method: "POST", body });
    expect(await (await post('{"name":"abc"}')).json()).toEqual({ name: "abc" });
    const bad = await post('{"name":"x"}');
    expect(bad.status).toBe(400);
    const message = JSON.stringify(await bad.json());
    expect(message).toContain("name");
    expect(message).not.toContain('"x"');
    expect((await post("not json")).status).toBe(400);
  });

  it("refuses a body over the cap with 413", async () => {
    const base = await start([
      ["POST", "/x", async (req) => json(200, await readJson(req, schema, { maxBytes: 20 }))],
    ]);
    const big = await fetch(`${base}/x`, {
      method: "POST",
      body: JSON.stringify({ name: "a".repeat(100) }),
    });
    expect(big.status).toBe(413);
    const small = await fetch(`${base}/x`, {
      method: "POST",
      body: JSON.stringify({ name: "abc" }),
    });
    expect(small.status).toBe(200);
  });
});

describe("serve", () => {
  it("streams a response and aborts the request signal when the client leaves", async () => {
    const aborted = Promise.withResolvers<void>();
    const base = await start([
      [
        "GET",
        "/stream",
        (request) => {
          request.signal.addEventListener("abort", () => aborted.resolve());
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      ],
    ]);
    const controller = new AbortController();
    const response = await fetch(`${base}/stream`, { signal: controller.signal });
    const reader = response.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toBe("first\n");
    gc();
    controller.abort();
    await aborted.promise;
  });

  it("passes request bodies and headers through", async () => {
    const base = await start([
      [
        "POST",
        "/echo",
        async (req) => json(200, { body: await req.text(), token: bearerToken(req) ?? null }),
      ],
    ]);
    const response = await fetch(`${base}/echo`, {
      method: "POST",
      body: "hello",
      headers: { authorization: "Bearer abc123" },
    });
    expect(await response.json()).toEqual({ body: "hello", token: "abc123" });
  });
});

describe("hostile requests", () => {
  const raw = (port: number, request: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString();
      });
      socket.on("close", () => resolve(received));
      socket.setTimeout(2000, () => socket.destroy());
    });

  it("answers a method or Host header Fetch cannot represent, and keeps serving", async () => {
    const server = await serve(createRouter([["GET", "/ok", () => json(200, { ok: true })]]), {
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    const trace = await raw(
      server.port,
      "TRACE /ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(trace).toMatch(/^HTTP\/1\.1 400/);
    const host = await raw(
      server.port,
      "GET /ok HTTP/1.1\r\nHost: a@b c\r\nConnection: close\r\n\r\n",
    );
    expect(host).toMatch(/^HTTP\/1\.1 200/);
    const target = await raw(
      server.port,
      "GET http://evil.example/ok HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    expect(target).toMatch(/^HTTP\/1\.1 400/);
    expect((await fetch(`http://127.0.0.1:${server.port}/ok`)).status).toBe(200);
  });

  it("releases a stream whose client left while its writes were blocked", async () => {
    const cancelled = Promise.withResolvers<void>();
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(chunk),
      cancel: () => cancelled.resolve(),
    });
    const server = await serve(createRouter([["GET", "/stream", () => new Response(body)]]), {
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    const socket = connect(server.port, "127.0.0.1", () =>
      socket.write("GET /stream HTTP/1.1\r\nHost: x\r\n\r\n"),
    );
    socket.pause();
    await sleep(500); // the kernel buffers fill and the server blocks on drain
    socket.destroy();
    await Promise.race([
      cancelled.promise,
      sleep(5000).then(() => {
        throw new Error("the stream was never released");
      }),
    ]);
  });
});
