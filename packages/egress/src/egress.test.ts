import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOCKED_RANGES, createEgressFetch, type EgressOptions } from "./index.ts";

// Loopback is allowed only here, so a local server can play the public internet.
const LOOPBACK_ALLOWED = BLOCKED_RANGES.filter((r) => r.why !== "loopback");

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let server: Server;
let origin: string;
let port: number;

function route(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? "/", "http://x");
  switch (url.pathname) {
    case "/hello":
      res.setHeader("x-reply", "1");
      res.end("hello");
      return;
    case "/echo":
      res.end(body);
      return;
    case "/redirect":
      res.writeHead(Number(url.searchParams.get("status") ?? 302), {
        location: url.searchParams.get("to") ?? "/hello",
      });
      res.end();
      return;
    case "/loop":
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    case "/big":
      res.end("x".repeat(2048));
      return;
    case "/big-chunked":
      res.write("x".repeat(1024));
      res.end("x".repeat(1024));
      return;
    case "/bomb":
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.alloc(1024 * 1024)));
      return;
    case "/gzip":
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(gzipSync("compressed hello"));
      return;
    case "/stall":
      return;
    case "/stall-body":
      res.write("start");
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
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    route(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const local = (options: EgressOptions = {}) =>
  createEgressFetch({ blockedRanges: LOOPBACK_ALLOWED, ...options });

const lastSeen = (): Seen => {
  const last = seen.at(-1);
  if (!last) throw new Error("the server saw no request");
  return last;
};

describe("egress guard: success path", () => {
  it("fetches from an allowed address, with headers and body", async () => {
    const res = await local()(`${origin}/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-reply")).toBe("1");
    expect(await res.text()).toBe("hello");

    const echo = await local()(`${origin}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await echo.json()).toEqual({ a: 1 });
    expect(lastSeen().headers.authorization).toBe("Bearer t");
  });

  it("connects to the address it checked, never asking DNS again", async () => {
    const asked: string[] = [];
    const egress = local({
      resolve: async (host) => {
        asked.push(host);
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const res = await egress(`http://tool.invalid:${port}/hello`);
    expect(await res.text()).toBe("hello");
    expect(asked).toEqual(["tool.invalid"]);
    expect(lastSeen().headers.host).toBe(`tool.invalid:${port}`);
  });

  it("decodes a compressed response", async () => {
    const res = await local()(`${origin}/gzip`);
    expect(await res.text()).toBe("compressed hello");
  });

  it("follows redirects by hand and reports where it ended", async () => {
    const res = await local()(`${origin}/redirect?to=/hello`);
    expect(await res.text()).toBe("hello");
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`${origin}/hello`);
  });

  it("keeps method and body on 307, turns POST into GET on 302", async () => {
    const keep = await local()(`${origin}/redirect?status=307&to=/echo`, {
      method: "POST",
      body: "payload",
    });
    expect(await keep.text()).toBe("payload");
    expect(lastSeen().method).toBe("POST");

    await (
      await local()(`${origin}/redirect?status=302&to=/echo`, {
        method: "POST",
        body: "payload",
      })
    ).text();
    expect(lastSeen()).toMatchObject({ method: "GET", body: "" });
  });

  it("drops credentials when a redirect changes origin", async () => {
    const egress = local({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    const to = encodeURIComponent(`http://elsewhere.invalid:${port}/hello`);
    await (
      await egress(`${origin}/redirect?to=${to}`, {
        headers: { authorization: "Bearer secret", cookie: "c=1", "x-keep": "yes" },
      })
    ).text();
    expect(lastSeen().headers).not.toHaveProperty("authorization");
    expect(lastSeen().headers).not.toHaveProperty("cookie");
    expect(lastSeen().headers["x-keep"]).toBe("yes");
  });

  it("returns the redirect itself with redirect: manual", async () => {
    const res = await local()(`${origin}/redirect?to=/hello`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/hello");
  });
});

describe("egress guard: refusals", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://224.0.0.1/",
    "http://198.18.0.1/",
    "http://[::]/",
    "http://[::1]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[::127.0.0.1]/",
    "http://[2002:7f00:1::]/",
  ])("refuses %s before connecting", async (url) => {
    await expect(createEgressFetch()(url)).rejects.toMatchObject({
      name: "EgressError",
      reason: "blocked_address",
    });
  });

  it("names the range in the error", async () => {
    await expect(createEgressFetch()("http://[::ffff:169.254.169.254]/")).rejects.toThrow(
      "::ffff:a9fe:a9fe is in blocked range 169.254.0.0/16 (link-local, cloud metadata)",
    );
  });

  it("refuses a hostname that resolves to a private address", async () => {
    await expect(createEgressFetch()(`http://localhost:${port}/hello`)).rejects.toMatchObject({
      reason: "blocked_address",
    });
    const internal = createEgressFetch({
      resolve: async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    await expect(internal("https://tool.invalid/")).rejects.toThrow(
      "tool.invalid resolves to 10.0.0.5, which is in blocked range 10.0.0.0/8 (private)",
    );
  });

  it("refuses a redirect from an allowed server to a private address", async () => {
    const to = encodeURIComponent("http://169.254.169.254/latest/meta-data/");
    await expect(local()(`${origin}/redirect?to=${to}`)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("lets a named host through, and only that host, even when it redirects", async () => {
    const named = createEgressFetch({
      allowedHosts: ["MCP-Fixture"],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(await (await named(`http://mcp-fixture:${port}/hello`)).text()).toBe("hello");
    await expect(named(`http://other.invalid:${port}/hello`)).rejects.toMatchObject({
      reason: "blocked_address",
    });
    const to = encodeURIComponent("http://169.254.169.254/latest/meta-data/");
    await expect(named(`http://mcp-fixture:${port}/redirect?to=${to}`)).rejects.toMatchObject({
      reason: "blocked_address",
    });
  });

  it("refuses endless redirects and redirect: error", async () => {
    await expect(local({ maxRedirects: 3 })(`${origin}/loop`)).rejects.toMatchObject({
      reason: "too_many_redirects",
    });
    await expect(
      local()(`${origin}/redirect?to=/hello`, { redirect: "error" }),
    ).rejects.toMatchObject({ reason: "redirect" });
  });

  it("refuses other schemes and credentials in the URL", async () => {
    await expect(createEgressFetch()("file:///etc/passwd")).rejects.toMatchObject({
      reason: "scheme",
    });
    await expect(local()(`http://user:pass@127.0.0.1:${port}/hello`)).rejects.toMatchObject({
      reason: "credentials",
    });
    await expect(createEgressFetch()("not a url")).rejects.toMatchObject({
      reason: "invalid_url",
    });
  });

  it("refuses an oversize response, declared, streamed or compressed", async () => {
    const small = local({ maxResponseBytes: 1024 });
    await expect(small(`${origin}/big`)).rejects.toMatchObject({ reason: "response_too_large" });
    const chunked = await small(`${origin}/big-chunked`);
    await expect(chunked.text()).rejects.toMatchObject({ reason: "response_too_large" });
    const bomb = await local({ maxResponseBytes: 64 * 1024 })(`${origin}/bomb`);
    await expect(bomb.arrayBuffer()).rejects.toMatchObject({ reason: "response_too_large" });
  });

  it("refuses an oversize request body", async () => {
    const before = seen.length;
    await expect(
      local({ maxRequestBytes: 1024 })(`${origin}/echo`, {
        method: "POST",
        body: "x".repeat(2048),
      }),
    ).rejects.toMatchObject({ reason: "request_too_large" });
    expect(seen.length).toBe(before);
  });

  it("times out a slow response and a slow body", async () => {
    const quick = local({ timeoutMs: 200 });
    await expect(quick(`${origin}/stall`)).rejects.toMatchObject({ reason: "timeout" });
    const res = await quick(`${origin}/stall-body`);
    await expect(res.text()).rejects.toMatchObject({ reason: "timeout" });
  });

  it("passes the caller's abort through", async () => {
    const controller = new AbortController();
    const pending = local()(`${origin}/stall`, { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });
});
