import { setTimeout as sleep } from "node:timers/promises";
import type { AgentMessage } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import type {
  Conversation,
  EventEnvelope,
  GetConversationResponse,
  Limits,
  PostMessageResponse,
} from "@kerby/contracts";
import {
  createApiKey,
  createConsoleSession,
  insertConsoleUser,
  insertTenant,
  readModelKey,
  revokeApiKey,
  setTenantStatus,
} from "@kerby/control-plane";
import { createTestControlDb } from "@kerby/control-plane/testing";
import { notifyLive } from "@kerby/conversations";
import { completeTurnWith, createTestTenant, type TestTenant } from "@kerby/conversations/testing";
import { LISTEN_APPLICATION_NAME, TenantPools } from "@kerby/db";
import { createOpener, createSealer, generateSecretsKeyPair } from "@kerby/secrets";
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
type Tenant = Awaited<ReturnType<Harness["tenant"]>>;

async function harness(
  options: {
    authCacheMs?: number;
    keyless?: string[];
    maxStreams?: number;
    providers?: string[];
    failedAuthPerMinute?: number;
    trustProxy?: boolean;
    maxStreamsPerProcess?: number;
  } = {},
) {
  const keys = generateSecretsKeyPair();
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
    sealer: createSealer(keys.publicKey),
    settings: {
      defaultModel: "faux/faux-1",
      modelProviders: options.providers ?? ["anthropic", "openai"],
      keylessProviders: options.keyless ?? ["faux"],
      defaultSystem: "Be helpful.",
      authCacheMs: options.authCacheMs ?? 0,
      maxStreamsPerTenant: options.maxStreams ?? 20,
      maxStreamsPerProcess: options.maxStreamsPerProcess ?? 100,
      streamRecheckMs: 100,
      defaultRequestsPerMinute: 10_000,
      defaultStorageBytes: 1024 ** 3,
      failedAuthPerMinute: options.failedAuthPerMinute ?? 1000,
      trustProxy: options.trustProxy ?? false,
    },
  };
  const server = await serve(createApiApp(deps), { host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  /** A tenant: a control-plane row, a key, and its own migrated database. */
  async function tenant(name: string, limits: Limits = {}) {
    const row = await insertTenant(control.db, { name, dbHost: "h", dbPort: 1, limits });
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

  /** A person of the tenant, signed in on the console: the session token the console would forward. `ttlMs` < 0 is expired. */
  async function signIn(tenantId: string, ttlMs = 60_000): Promise<string> {
    const { id } = await insertConsoleUser(control.db, {
      tenantId,
      email: `${crypto.randomUUID()}@example.com`,
      passwordHash: "scrypt$17$8$1$c2FsdA==$aGFzaA==",
    });
    return createConsoleSession(control.db, { id, tenantId }, new Date(Date.now() + ttlMs));
  }
  return { control, blobs, deps, base, tenant, call, keys, signIn };
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
    await expect(auth.authenticate(t.secret)).resolves.toEqual({
      tenantId: t.id,
      actor: `key:${t.key.id}`,
      limits: {},
    });

    await setTenantStatus(h.control.db, t.id, "suspended");
    clock += 29_999;
    await expect(auth.authenticate(t.secret)).resolves.toBeDefined(); // still inside the TTL
    clock += 2;
    await expect(auth.authenticate(t.secret)).rejects.toThrow(/suspended/);
  });

  it("accepts a console session as the signed-in person's tenant, and ends with the session or the tenant", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const other = await h.tenant("other");
    const token = await h.signIn(t.id);
    const created = await h.call(token, "POST", "/v1/conversations", {});
    expect(created.status).toBe(201);
    // the tenant is the session's: the conversation is in acme's database, not the other's
    expect((await t.database.db.query("select 1 from conversations")).rowCount).toBe(1);
    expect((await other.database.db.query("select 1 from conversations")).rowCount).toBe(0);

    const auth = createAuthenticator(h.control.db, 0);
    await expect(auth.authenticate(token)).resolves.toMatchObject({
      tenantId: t.id,
      actor: expect.stringMatching(/^user:[0-9a-f-]{36}$/),
    });
    expect(
      (
        await h.call(
          `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
          "GET",
          "/v1/conversations",
        )
      ).status,
    ).toBe(401);
    expect((await h.call(await h.signIn(t.id, -1_000), "GET", "/v1/conversations")).status).toBe(
      401,
    );

    await setTenantStatus(h.control.db, t.id, "suspended");
    expect((await h.call(token, "GET", "/v1/conversations")).status).toBe(403);
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
    expect(conversation.title).toBeNull();
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

describe("browsing conversations", () => {
  type Listed = {
    conversations: {
      id: string;
      externalUserId: string | null;
      title: string | null;
      messageCount: number;
      updatedAt: string;
    }[];
    nextCursor: string | null;
  };
  const list = async (h: Harness, credential: string, query = ""): Promise<Listed> => {
    const response = await h.call(credential, "GET", `/v1/conversations${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Listed;
  };
  const post = async (h: Harness, credential: string, id: string, content: string) =>
    expect(
      (await h.call(credential, "POST", `/v1/conversations/${id}/messages`, { content })).status,
    ).toBe(202);

  it("lists every conversation however it began, most recently active first, titled by its first message", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const person = await h.signIn(t.id);
    const fromApi = await newConversation(h, t.secret, { externalUserId: "u1" });
    await post(h, t.secret, fromApi.id, "  hello\n\n   world  ");
    const fromConsole = await newConversation(h, person, { externalUserId: "console:someone" });
    await post(h, person, fromConsole.id, "x".repeat(200));
    const empty = await newConversation(h, t.secret);
    // the API-made conversation is answered last, so it is the most recently active
    await completeTurnWith(t.ctx, h.blobs, fromApi.id, [assistant("hi")]);

    for (const credential of [t.secret, person]) {
      const { conversations, nextCursor } = await list(h, credential);
      expect(nextCursor).toBeNull();
      expect(conversations.map((c) => c.id)).toEqual([fromApi.id, empty.id, fromConsole.id]);
      const byId = new Map(conversations.map((c) => [c.id, c]));
      expect(byId.get(fromApi.id)).toMatchObject({
        title: "hello world",
        messageCount: 2,
        externalUserId: "u1",
      });
      expect(byId.get(fromConsole.id)).toMatchObject({
        title: `${"x".repeat(80)}…`,
        messageCount: 1,
      });
      expect(byId.get(empty.id)).toMatchObject({ title: null, messageCount: 0 });
      expect(conversations.every((c) => !("system" in c))).toBe(true);
    }
    expect((await list(h, t.secret, "?externalUserId=u1")).conversations.map((c) => c.id)).toEqual([
      fromApi.id,
    ]);
  });

  it("pages by cursor without repeating or skipping, and refuses a cursor it did not make", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await newConversation(h, t.secret)).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Listed = await list(
        h,
        t.secret,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.conversations.length).toBeLessThanOrEqual(2);
      seen.push(...page.conversations.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    // newest first: creation order reversed
    expect(seen).toEqual(made.toReversed());

    for (const query of ["?cursor=nonsense", "?limit=0", "?limit=101"]) {
      expect((await h.call(t.secret, "GET", `/v1/conversations${query}`)).status, query).toBe(400);
    }
  });

  it("shows a tenant only its own conversations", async () => {
    const h = await harness();
    const a = await h.tenant("a");
    const b = await h.tenant("b");
    const mine = await newConversation(h, a.secret);
    await newConversation(h, b.secret);
    expect((await list(h, a.secret)).conversations.map((c) => c.id)).toEqual([mine.id]);
    expect((await list(h, await h.signIn(b.id))).conversations).toHaveLength(1);
    expect((await h.call(await h.signIn(b.id), "GET", `/v1/conversations/${mine.id}`)).status).toBe(
      404,
    );
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

  it("shares one LISTEN connection among a tenant's streams and releases it when the last client goes away", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversations = [await newConversation(h, t.secret), await newConversation(h, t.secret)];
    const listening = async () =>
      (
        await t.ctx.db.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where application_name = $1 and datname = current_database()",
          [LISTEN_APPLICATION_NAME],
        )
      ).rows[0]?.n;
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    for (const [i, controller] of controllers.entries()) {
      const response = await fetch(
        `${h.base}/v1/conversations/${conversations[i % 2]?.id}/events`,
        { headers: { authorization: `Bearer ${t.secret}` }, signal: controller.signal },
      );
      await response.body?.getReader().read(); // the stream is open
    }
    expect(await listening()).toBe(1);
    for (const controller of controllers.slice(1)) controller.abort();
    await sleep(200);
    expect(await listening()).toBe(1);
    controllers[0]?.abort();
    for (let i = 0; i < 40 && (await listening()) !== 0; i++) await sleep(50);
    expect(await listening()).toBe(0);
  });
});

describe("event stream limits", () => {
  const open = (h: Harness, secret: string, id: string, signal?: AbortSignal) =>
    fetch(`${h.base}/v1/conversations/${id}/events`, {
      headers: { authorization: `Bearer ${secret}` },
      ...(signal ? { signal } : {}),
    });

  it("caps open streams per tenant and frees a slot when one closes", async () => {
    const h = await harness({ maxStreams: 2 });
    const t = await h.tenant("acme");
    const other = await h.tenant("other");
    const { id } = await newConversation(h, t.secret);
    const { id: otherId } = await newConversation(h, other.secret);
    const first = new AbortController();
    const a = await open(h, t.secret, id, first.signal);
    const b = await open(h, t.secret, id);
    expect([a.status, b.status]).toEqual([200, 200]);
    const refused = await open(h, t.secret, id);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "too_many_streams" } });
    // another tenant is not affected
    expect((await open(h, other.secret, otherId)).status).toBe(200);

    first.abort();
    await a.body?.cancel().catch(() => {});
    let status = 429;
    for (let i = 0; i < 40 && status === 429; i++) {
      await sleep(50);
      const retry = await open(h, t.secret, id);
      status = retry.status;
      await retry.body?.cancel().catch(() => {});
    }
    expect(status).toBe(200);
    await b.body?.cancel().catch(() => {});
  });

  it("caps open streams per process across tenants with a 503, and frees a slot when one closes", async () => {
    const h = await harness({ maxStreams: 2, maxStreamsPerProcess: 3 });
    const t = await h.tenant("acme");
    const other = await h.tenant("other");
    const { id } = await newConversation(h, t.secret);
    const { id: otherId } = await newConversation(h, other.secret);
    const first = new AbortController();
    const opened = [
      await open(h, t.secret, id, first.signal),
      await open(h, t.secret, id),
      await open(h, other.secret, otherId),
    ];
    expect(opened.map((r) => r.status)).toEqual([200, 200, 200]);
    // `other` is under its own cap, but the process is full.
    const refused = await open(h, other.secret, otherId);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "server_busy",
        message: expect.stringMatching(/maximum of 3 open event streams/),
      },
    });

    first.abort();
    await opened[0]?.body?.cancel().catch(() => {});
    let status = 503;
    for (let i = 0; i < 40 && status === 503; i++) {
      await sleep(50);
      const retry = await open(h, other.secret, otherId);
      status = retry.status;
      await retry.body?.cancel().catch(() => {});
    }
    expect(status).toBe(200);
    for (const response of opened.slice(1)) await response.body?.cancel().catch(() => {});
  });

  it.each([
    ["its key is revoked", (h: Harness, t: Tenant) => revokeApiKey(h.control.db, t.id, t.key.id)],
    [
      "its tenant is suspended",
      (h: Harness, t: Tenant) => setTenantStatus(h.control.db, t.id, "suspended"),
    ],
  ])("ends an open stream when %s", async (_name, stop) => {
    const h = await harness();
    const t = await h.tenant("acme");
    const { id } = await newConversation(h, t.secret);
    const response = await open(h, t.secret, id);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    await reader?.read(); // open
    await stop(h, t);
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader?.read())?.done !== false) return true;
      })(),
      sleep(5000).then(() => false),
    ]);
    expect(ended).toBe(true);
  });
});

describe("model keys (bring your own key)", () => {
  const KEY = "sk-ant-api03-0123456789abcdef";

  it("stores a key sealed, lists providers without the key, and removes it", async () => {
    const h = await harness({ keyless: [] });
    const t = await h.tenant("acme");
    const put = await h.call(t.secret, "PUT", "/v1/model-keys/anthropic", { apiKey: KEY });
    expect(put.status).toBe(204);

    const list = await h.call(t.secret, "GET", "/v1/model-keys");
    const body = await list.text();
    expect(JSON.parse(body)).toMatchObject({ keys: [{ provider: "anthropic" }] });
    expect(body).not.toContain(KEY);

    const stored = await h.control.db.query<{ ciphertext: Buffer }>(
      "select ciphertext from tenant_secrets",
    );
    expect(stored.rows[0]?.ciphertext.includes(Buffer.from(KEY))).toBe(false);
    const opener = createOpener([h.keys.privateKey]);
    expect(await readModelKey(h.control.db, opener, t.id, "anthropic")).toBe(KEY);

    const audit = await h.control.db.query("select actor, action, detail from audit_log");
    expect(audit.rows).toEqual([
      {
        actor: expect.stringMatching(/^key:/),
        action: "model_key.set",
        detail: { provider: "anthropic" },
      },
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(KEY);

    expect((await h.call(t.secret, "DELETE", "/v1/model-keys/anthropic")).status).toBe(204);
    expect((await h.call(t.secret, "DELETE", "/v1/model-keys/anthropic")).status).toBe(404);
    expect(await (await h.call(t.secret, "GET", "/v1/model-keys")).json()).toEqual({ keys: [] });
  });

  it("keeps one tenant's keys invisible to another", async () => {
    const h = await harness({ keyless: [] });
    const a = await h.tenant("a");
    const b = await h.tenant("b");
    await h.call(a.secret, "PUT", "/v1/model-keys/openai", { apiKey: KEY });
    expect(await (await h.call(b.secret, "GET", "/v1/model-keys")).json()).toEqual({ keys: [] });
    expect((await h.call(b.secret, "DELETE", "/v1/model-keys/openai")).status).toBe(404);
    expect(await (await h.call(a.secret, "GET", "/v1/model-keys")).json()).toMatchObject({
      keys: [{ provider: "openai" }],
    });
  });

  it("requires a valid API key and a well-formed provider and key", async () => {
    const h = await harness({ keyless: [] });
    const t = await h.tenant("acme");
    expect((await h.call(null, "PUT", "/v1/model-keys/openai", { apiKey: KEY })).status).toBe(401);
    expect((await h.call(null, "GET", "/v1/model-keys")).status).toBe(401);
    for (const apiKey of ["short", "has space in it", "line\nbreak-key-123", "é".repeat(20)]) {
      expect((await h.call(t.secret, "PUT", "/v1/model-keys/openai", { apiKey })).status).toBe(400);
    }
    expect(await (await h.call(t.secret, "GET", "/v1/model-keys")).json()).toEqual({ keys: [] });
  });

  it("refuses a conversation on a provider the tenant has no key for, until it adds one", async () => {
    const h = await harness({ keyless: [] });
    const t = await h.tenant("acme");
    const refused = await h.call(t.secret, "POST", "/v1/conversations", { model: "anthropic/x" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "invalid_model",
        message: expect.stringContaining("PUT /v1/model-keys/anthropic"),
      },
    });
    await h.call(t.secret, "PUT", "/v1/model-keys/anthropic", { apiKey: KEY });
    expect(
      (await h.call(t.secret, "POST", "/v1/conversations", { model: "anthropic/x" })).status,
    ).toBe(201);
    // another provider is still refused
    expect(
      (await h.call(t.secret, "POST", "/v1/conversations", { model: "openai/x" })).status,
    ).toBe(400);
  });

  it("refuses a provider the harness does not support, naming the supported ones", async () => {
    const h = await harness({ keyless: [] });
    const t = await h.tenant("acme");
    for (const provider of ["nope", "Open_AI"]) {
      const refused = await h.call(t.secret, "PUT", `/v1/model-keys/${provider}`, { apiKey: KEY });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: {
          code: "unknown_provider",
          message: "unknown model provider; supported: anthropic, openai",
        },
      });
    }
    expect(await (await h.call(t.secret, "GET", "/v1/model-keys")).json()).toEqual({ keys: [] });
  });

  it("caps how many providers one tenant can store", async () => {
    const providers = Array.from({ length: 33 }, (_, i) => `p${i}`);
    const h = await harness({ keyless: [], providers });
    const t = await h.tenant("acme");
    for (const provider of providers.slice(0, 32)) {
      expect(
        (await h.call(t.secret, "PUT", `/v1/model-keys/${provider}`, { apiKey: KEY })).status,
      ).toBe(204);
    }
    expect((await h.call(t.secret, "PUT", "/v1/model-keys/p32", { apiKey: KEY })).status).toBe(409);
  });
});

describe("paged reads", () => {
  /** A conversation of `count` messages: one question and its answers. */
  async function longConversation(h: Harness, t: Tenant, count: number) {
    const { id } = await newConversation(h, t.secret);
    await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "go" });
    await completeTurnWith(
      t.ctx,
      h.blobs,
      id,
      Array.from({ length: count - 1 }, (_, i) => assistant(`answer ${i + 2}`)),
    );
    return id;
  }

  it("pages a conversation with after and limit, and says where the next page starts", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const id = await longConversation(h, t, 250);
    const page = async (query: string) => {
      const response = await h.call(t.secret, "GET", `/v1/conversations/${id}${query}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GetConversationResponse;
      return { seqs: body.messages.map((m) => m.seq), nextAfter: body.nextAfter };
    };
    const first = await page("");
    expect(first.seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(first.nextAfter).toBe(100);
    const rest = await page("?after=100&limit=500");
    expect(rest.seqs).toEqual(Array.from({ length: 150 }, (_, i) => i + 101));
    expect(rest.nextAfter).toBeNull();
    expect(await page("?after=248&limit=2")).toEqual({ seqs: [249, 250], nextAfter: null });
    expect(await page("?after=247&limit=2")).toEqual({ seqs: [248, 249], nextAfter: 249 });
    expect(await page("?after=250")).toEqual({ seqs: [], nextAfter: null });
    for (const bad of ["?limit=0", "?limit=501", "?after=-1", "?after=x", "?limit=1.5"]) {
      const response = await h.call(t.secret, "GET", `/v1/conversations/${id}${bad}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("replays a conversation longer than one page over the event stream, in order", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const id = await longConversation(h, t, 250);
    const response = await h.call(t.secret, "GET", `/v1/conversations/${id}/events`, undefined, {
      "last-event-id": "20",
    });
    const events = await readEvents(response, 230);
    expect(events.map((e) => Number(e.id))).toEqual(Array.from({ length: 230 }, (_, i) => i + 21));
  });
});

describe("request rate limit", () => {
  it("refuses a tenant's requests with 429 once its bucket is empty, without touching another tenant", async () => {
    const h = await harness();
    const t = await h.tenant("acme", { requestsPerMinute: 3 });
    const other = await h.tenant("other", { requestsPerMinute: 3 });
    for (let i = 0; i < 3; i++)
      expect((await h.call(t.secret, "GET", "/v1/model-keys")).status).toBe(200);
    const refused = await h.call(t.secret, "GET", "/v1/model-keys");
    expect(refused.status).toBe(429);
    // One token comes back every 20 s at 3 a minute.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(20);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await h.call(other.secret, "GET", "/v1/model-keys")).status).toBe(200);
  });
});

describe("failed authentication limit", () => {
  it("refuses an address that keeps failing, before any key lookup", async () => {
    const h = await harness({ failedAuthPerMinute: 3 });
    const t = await h.tenant("acme");
    for (const key of [null, "garbage", `kb_000000000000_${"A".repeat(43)}`])
      expect((await h.call(key, "GET", "/v1/model-keys")).status).toBe(401);
    // Even a valid key from that address is refused now: the address is what is limited.
    const refused = await h.call(t.secret, "GET", "/v1/model-keys");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ error: { code: "rate_limited" } });
    // Without TRUST_PROXY a forwarded address is ignored: anyone can send the header.
    const spoofed = await h.call(t.secret, "GET", "/v1/model-keys", undefined, {
      "x-forwarded-for": "198.51.100.7",
    });
    expect(spoofed.status).toBe(429);
  });

  it("behind a trusted proxy, limits the left-most X-Forwarded-For address", async () => {
    const h = await harness({ failedAuthPerMinute: 2, trustProxy: true });
    const t = await h.tenant("acme");
    const from = (address: string) => ({ "x-forwarded-for": `${address}, 10.0.0.1` });
    for (let i = 0; i < 2; i++)
      expect(
        (await h.call("garbage", "GET", "/v1/model-keys", undefined, from("203.0.113.1"))).status,
      ).toBe(401);
    expect(
      (await h.call(t.secret, "GET", "/v1/model-keys", undefined, from("203.0.113.1"))).status,
    ).toBe(429);
    expect(
      (await h.call(t.secret, "GET", "/v1/model-keys", undefined, from("203.0.113.2"))).status,
    ).toBe(200);
  });
});

describe("storage quota", () => {
  it("refuses a message past the tenant's quota with 413; an admitted turn still finishes", async () => {
    const h = await harness();
    const t = await h.tenant("acme", { storageBytes: 200 });
    const { id } = await newConversation(h, t.secret);
    expect(
      (await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, { content: "hello" }))
        .status,
    ).toBe(202);
    // The answer takes the tenant past its quota: it is stored all the same.
    await completeTurnWith(t.ctx, h.blobs, id, [assistant("x".repeat(300))]);
    const view = (await (
      await h.call(t.secret, "GET", `/v1/conversations/${id}`)
    ).json()) as GetConversationResponse;
    expect(view.messages).toHaveLength(2);
    const refused = await h.call(t.secret, "POST", `/v1/conversations/${id}/messages`, {
      content: "more",
    });
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: { code: "storage_quota_exceeded" } });
    expect((await t.database.db.query("select 1 from messages")).rowCount).toBe(2);
  });
});
