import { setTimeout as sleep } from "node:timers/promises";
import type { AgentMessage } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import type {
  Conversation,
  EventEnvelope,
  GetConversationResponse,
  PostMessageResponse,
} from "@kerby/contracts";
import { createApiKey, insertTenant, revokeApiKey, setTenantStatus } from "@kerby/control-plane";
import { createTestControlDb } from "@kerby/control-plane/testing";
import { notifyLive } from "@kerby/conversations";
import { completeTurnWith, createTestTenant, type TestTenant } from "@kerby/conversations/testing";
import { TenantPools } from "@kerby/db";
import { serve } from "@kerby/serve";
import { afterEach, describe, expect, it } from "vitest";
import { createApiApp } from "./index.ts";
import { createAuthenticator } from "./service/auth.ts";
import type { ApiDeps } from "./types/index.ts";

const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(options: { authCacheMs?: number } = {}) {
  const control = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const blobs = await createTestBlobs();
  const urls = new Map<string, string>();
  const pools = new TenantPools({
    resolveUrl: async (id) => urls.get(id) ?? Promise.reject(new Error(`unknown tenant ${id}`)),
  });
  cleanups.push(() => pools.close());
  const deps: ApiDeps = {
    control: control.db,
    pools,
    blobs,
    settings: {
      models: ["faux/faux-1", "faux/other"],
      defaultSystem: "Be helpful.",
      authCacheMs: options.authCacheMs ?? 0,
    },
  };
  const server = await serve(createApiApp(deps), { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  /** A tenant: a control-plane row, a key, and its own migrated database. */
  async function tenant(name: string) {
    const row = await insertTenant(control.db, { name, dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, row.id, "active");
    const { key, secret } = await createApiKey(control.db, row.id);
    const database: TestTenant = await createTestTenant();
    cleanups.push(() => database[Symbol.asyncDispose]());
    urls.set(row.id, database.url);
    return { id: row.id, key, secret, ctx: { tenantId: row.id, db: database.db }, database };
  }

  const call = (
    secret: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { control, blobs, deps, base, tenant, call };
}

const text = (value: string) => [{ type: "text", text: value }] as const;
const assistant = (value: string): AgentMessage => ({
  role: "assistant",
  model: "faux/faux-1",
  stopReason: "end",
  content: [...text(value)],
  native: { secret: "chain of thought" },
});

async function newConversation(
  h: Harness,
  secret: string,
  body: object = {},
): Promise<Conversation> {
  const response = await h.call(secret, "POST", "/v1/conversations", body);
  expect(response.status).toBe(201);
  return (await response.json()) as Conversation;
}

describe("authentication", () => {
  it("refuses a missing, malformed or unknown key; /healthz is open", async () => {
    const h = await harness();
    expect((await h.call(null, "POST", "/v1/conversations", {})).status).toBe(401);
    expect((await h.call("garbage", "POST", "/v1/conversations", {})).status).toBe(401);
    expect(
      (await h.call(`kb_000000000000_${"A".repeat(43)}`, "POST", "/v1/conversations", {})).status,
    ).toBe(401);
    expect((await h.call(null, "GET", "/healthz")).status).toBe(200);
  });

  it("refuses a revoked key and a suspended tenant", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    expect((await h.call(t.secret, "POST", "/v1/conversations", {})).status).toBe(201);
    await setTenantStatus(h.control.db, t.id, "suspended");
    const suspended = await h.call(t.secret, "POST", "/v1/conversations", {});
    expect(suspended.status).toBe(403);
    await setTenantStatus(h.control.db, t.id, "active");
    await revokeApiKey(h.control.db, t.id, t.key.id);
    expect((await h.call(t.secret, "POST", "/v1/conversations", {})).status).toBe(401);
  });

  it("trusts a verified key for the cache TTL and no longer", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    let clock = 1_000;
    const auth = createAuthenticator(h.control.db, 30_000, () => clock);
    await expect(auth.authenticate(t.secret)).resolves.toEqual({ tenantId: t.id, keyId: t.key.id });

    await setTenantStatus(h.control.db, t.id, "suspended");
    clock += 29_999;
    await expect(auth.authenticate(t.secret)).resolves.toBeDefined(); // still inside the TTL
    clock += 2;
    await expect(auth.authenticate(t.secret)).rejects.toThrow(/suspended/);
  });
});

describe("conversations", () => {
  it("creates a conversation with the default model and system, and rejects other models", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversation = await newConversation(h, t.secret, { externalUserId: "user-1" });
    expect(conversation).toMatchObject({
      model: "faux/faux-1",
      system: "Be helpful.",
      externalUserId: "user-1",
    });
    const other = await newConversation(h, t.secret, { model: "faux/other", system: "Terse." });
    expect(other).toMatchObject({ model: "faux/other", system: "Terse." });
    const bad = await h.call(t.secret, "POST", "/v1/conversations", { model: "gpt-9000" });
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_model" },
    });
  });

  it("posts a message: stored, turn enqueued, conversation busy until it is answered", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const { id } = await newConversation(h, t.secret);

    const posted = await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, {
      content: "hello",
    });
    expect(posted.status).toBe(202);
    expect((await posted.json()) as PostMessageResponse).toEqual({ seq: 1 });
    expect((await t.database.db.query("select 1 from absurd.t_turns")).rowCount).toBe(1);

    const view = (await (
      await h.call(t.secret, "GET", `/v1/conversations/${id}`)
    ).json()) as GetConversationResponse;
    expect(view.busy).toBe(true);
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.message).toEqual({ role: "user", content: [...text("hello")] });

    const second = await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, {
      content: "again",
    });
    expect(second.status).toBe(409);

    await completeTurnWith(t.ctx, h.blobs, id, [assistant("hi there")]);
    const after = (await (
      await h.call(t.secret, "GET", `/v1/conversations/${id}`)
    ).json()) as GetConversationResponse;
    expect(after.busy).toBe(false);
    expect(after.messages.map((m) => m.seq)).toEqual([1, 2]);
    // The harness's native payload never reaches a client.
    expect(JSON.stringify(after)).not.toContain("chain of thought");
    expect(
      (await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "thanks" }))
        .status,
    ).toBe(202);
  });

  it("returns 404 for unknown and malformed ids, and 400/413 for bad bodies", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    expect(
      (await h.call(t.secret, "GET", "/v1/conversations/6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11"))
        .status,
    ).toBe(404);
    expect((await h.call(t.secret, "GET", "/v1/conversations/not-a-uuid")).status).toBe(404);
    expect(
      (
        await h.call(
          t.secret,
          "POST",
          "/v1/conversations/6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11/messages",
          { content: "x" },
        )
      ).status,
    ).toBe(404);
    const { id } = await newConversation(h, t.secret);
    expect(
      (await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "" })).status,
    ).toBe(400);
    expect(
      (
        await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, {
          content: "x".repeat(5_000_000),
        })
      ).status,
    ).toBe(413);
  });
});

describe("tenant isolation", () => {
  it("one tenant's key cannot read, write or stream another tenant's conversation", async () => {
    const h = await harness();
    const a = await h.tenant("a");
    const b = await h.tenant("b");
    const { id } = await newConversation(h, a.secret);
    await h.call(a.secret, "POST", `/v1/conversations/${id}/messages`, { content: "a's secret" });

    expect((await h.call(b.secret, "GET", `/v1/conversations/${id}`)).status).toBe(404);
    expect(
      (await h.call(b.secret, "POST", `/v1/conversations/${id}/messages`, { content: "intrusion" }))
        .status,
    ).toBe(404);
    expect((await h.call(b.secret, "GET", `/v1/conversations/${id}/events`)).status).toBe(404);
    // and nothing leaked in either direction
    expect((await b.database.db.query("select 1 from conversations")).rowCount).toBe(0);
    expect((await a.database.db.query("select 1 from messages")).rowCount).toBe(1);
  });
});

/** Read server-sent events until `count` data events arrived (or the stream ends). */
async function readEvents(
  response: Response,
  count: number,
): Promise<{ id: string | null; event: EventEnvelope }[]> {
  const reader = response.body?.getReader() ?? expect.fail("no body");
  const decoder = new TextDecoder();
  const found: { id: string | null; event: EventEnvelope }[] = [];
  let buffer = "";
  while (found.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const id =
        block
          .split("\n")
          .find((line) => line.startsWith("id: "))
          ?.slice(4) ?? null;
      found.push({ id, event: JSON.parse(data.slice(6)) as EventEnvelope });
    }
  }
  await reader.cancel();
  return found;
}

describe("event stream", () => {
  it("replays persisted messages, then delivers live events and new messages in order", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const { id } = await newConversation(h, t.secret);
    await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "hello" });

    const controller = new AbortController();
    const response = await fetch(`${h.base}/v1/conversations/${id}/events`, {
      headers: { authorization: `Bearer ${t.secret}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reading = readEvents(response, 4);

    // A live delta, then the persisted answer.
    await sleep(300);
    await notifyLive(t.ctx.db, id, {
      v: 1,
      conversationId: id,
      runId: "r1",
      seq: 2,
      at: new Date().toISOString(),
      event: { type: "text_delta", text: "hi " },
    });
    await completeTurnWith(t.ctx, h.blobs, id, [assistant("hi there")]);
    await notifyLive(t.ctx.db, id, {
      v: 1,
      conversationId: id,
      runId: "r1",
      seq: 2,
      at: new Date().toISOString(),
      event: { type: "run_end", reason: "done" },
    });

    const events = await reading;
    expect(events.map((e) => [e.id, e.event.event.type])).toEqual([
      ["1", "message_end"],
      [null, "text_delta"],
      ["2", "message_end"],
      [null, "run_end"],
    ]);
    expect(events[0]?.event.event).toMatchObject({ message: { role: "user" } });
    expect(JSON.stringify(events)).not.toContain("chain of thought");
    controller.abort();
  });

  it("resumes after Last-Event-ID without repeating messages", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const { id } = await newConversation(h, t.secret);
    await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "hello" });
    await completeTurnWith(t.ctx, h.blobs, id, [assistant("one"), assistant("two")]);

    const response = await h.call(t.secret, "GET", `/v1/conversations/${id}/events`, undefined, {
      "last-event-id": "2",
    });
    const events = await readEvents(response, 1);
    expect(events.map((e) => e.id)).toEqual(["3"]);
    expect(events[0]?.event.event).toMatchObject({ message: { content: [{ text: "two" }] } });
  });

  it("releases its LISTEN connection when the client goes away", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const { id } = await newConversation(h, t.secret);
    const listening = async () =>
      Number(
        (
          await t.ctx.db.query<{ n: string }>(
            "select count(*)::text as n from pg_stat_activity where query like 'listen %' and datname = current_database()",
          )
        ).rows[0]?.n,
      );
    const controller = new AbortController();
    const response = await fetch(`${h.base}/v1/conversations/${id}/events`, {
      headers: { authorization: `Bearer ${t.secret}` },
      signal: controller.signal,
    });
    await response.body?.getReader().read(); // the stream is open
    expect(await listening()).toBe(1);
    controller.abort();
    for (let i = 0; i < 40 && (await listening()) !== 0; i++) await sleep(50);
    expect(await listening()).toBe(0);
  });
});
