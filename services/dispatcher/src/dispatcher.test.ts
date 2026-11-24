import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { EventTypePattern, Limits, Scope, SubscriptionScope } from "@kerby/contracts";
import {
  createIntegration,
  deleteSubscription,
  getSubscription,
  insertSubscription,
  insertTenant,
  setTenantStatus,
  updateSubscription,
} from "@kerby/control-plane";
import { createTestControlDb } from "@kerby/control-plane/testing";
import { createTestTenant } from "@kerby/conversations/testing";
import { TenantPools } from "@kerby/db";
import { DELIVERY_RETRY, spawnInTx } from "@kerby/durable";
import { listDeliveryAttempts, lockCursor, type NewEvent, recordEvent } from "@kerby/events";
import { configureLogging } from "@kerby/observability";
import { createOpener, createSealer, generateSecretsKeyPair } from "@kerby/secrets";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDestinations,
  createHandlers,
  createScheduler,
  type DispatcherDeps,
  dispatcherConfigSchema,
} from "./index.ts";

const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually<T>(
  what: string,
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

type Received = { path: string; headers: IncomingHttpHeaders; body: string };
type Answer = { status: number; body?: string; delayMs?: number };

/** A customer's endpoint on this machine: records every request, answers as the test says per path. */
async function receiver() {
  const received: Received[] = [];
  const answers = new Map<string, (request: Received) => Answer>();
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer(async (req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = {
      path: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    const answer = answers.get(request.path)?.(request) ?? { status: 200 };
    if (answer.delayMs) await sleep(answer.delayMs);
    received.push(request);
    inFlight--;
    res.statusCode = answer.status;
    res.end(answer.body ?? "ok");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    received,
    answers,
    maxInFlight: () => maxInFlight,
    at: (path: string) => received.filter((request) => request.path === path),
  };
}

type HarnessOptions = { settings?: Partial<DispatcherDeps["settings"]>; start?: boolean };

async function harness(options: HarnessOptions = {}) {
  const control = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const urls = new Map<string, string>();
  const pools = new TenantPools({
    resolveUrl: async (id) => urls.get(id) ?? Promise.reject(new Error(`unknown tenant ${id}`)),
  });
  cleanups.push(() => pools.close());
  const keys = generateSecretsKeyPair();
  const sealer = createSealer(keys.publicKey);
  const endpoint = await receiver();
  const deps: DispatcherDeps = {
    control: control.db,
    pools,
    opener: createOpener([keys.privateKey]),
    destinations: createDestinations(true),
    settings: {
      workerId: "test-dispatcher",
      claimTimeoutSeconds: 30,
      defaultConcurrentDeliveries: 4,
      maxRunningDeliveries: 20,
      sweepIntervalMs: 200,
      ...options.settings,
    },
  };

  async function dispatcher(workerId = "test-dispatcher") {
    const own: DispatcherDeps = { ...deps, settings: { ...deps.settings, workerId } };
    const scheduler = createScheduler(own, createHandlers(own));
    await scheduler.start();
    cleanups.push(() => scheduler.stop(0));
    return scheduler;
  }
  if (options.start !== false) await dispatcher();

  async function tenant(limits: Limits = {}) {
    const row = await insertTenant(control.db, {
      name: `t-${randomUUID()}`,
      dbHost: "h",
      dbPort: 1,
      limits,
    });
    await setTenantStatus(control.db, row.id, "active");
    const database = await createTestTenant();
    cleanups.push(() => database[Symbol.asyncDispose]());
    urls.set(row.id, database.url);
    const integration = (name: string, scopes: Scope[] = ["events"]) =>
      createIntegration(control.db, row.id, { name, scopes });
    return { id: row.id, db: database.db, integration };
  }
  type Tenant = Awaited<ReturnType<typeof tenant>>;

  /** A subscription the way the api makes one: sealed secret, cursor at "now". */
  async function subscribe(
    t: Tenant,
    integrationId: string,
    {
      types = ["*"],
      scope = "own",
    }: { types?: EventTypePattern[]; scope?: SubscriptionScope } = {},
  ) {
    const id = randomUUID();
    const secret = deps.destinations.webhook.newSecret();
    const path = `/hooks/${id}`;
    await insertSubscription(
      control.db,
      sealer,
      {
        id,
        tenantId: t.id,
        integrationId,
        destination: { kind: "webhook", url: `${endpoint.origin}${path}` },
        types,
        scope,
        description: "",
        secret,
      },
      10,
    );
    await t.db.transaction((tx) => lockCursor(tx, id));
    return { id, secret, path };
  }

  /** Record an event as an emitting transaction does, then tell the dispatchers unless `notify` is false. */
  async function emit(t: Tenant, event: Omit<NewEvent, "dedupeKey">, notify = true) {
    const dedupeKey = randomUUID();
    await t.db.transaction((tx) => recordEvent(tx, { ...event, dedupeKey } as NewEvent));
    const { rows } = await t.db.query<{ id: string }>(
      "select id::text from events where dedupe_key = $1",
      [dedupeKey],
    );
    if (notify) await control.db.query("select pg_notify('tenant_events', $1)", [t.id]);
    return rows[0]?.id ?? "";
  }

  const deliveryTasks = async (t: Tenant) =>
    (
      await t.db.query<{ state: string }>(
        "select state from absurd.t_deliveries order by enqueue_at",
      )
    ).rows.map((row) => row.state);

  return { control, deps, endpoint, dispatcher, tenant, subscribe, emit, deliveryTasks };
}

const started = (integrationId: string | null, seq = 1): Omit<NewEvent, "dedupeKey"> => ({
  type: "turn.started",
  integrationId,
  data: { conversationId: randomUUID(), seq },
});
const created = (integrationId: string | null): Omit<NewEvent, "dedupeKey"> => ({
  type: "conversation.created",
  integrationId,
  data: { conversationId: randomUUID(), externalUserId: null },
});

/** What a receiver does with the Standard Webhooks headers: recompute the signature under the secret. */
function verify(secret: string, request: Received): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const id = String(request.headers["webhook-id"]);
  const timestamp = String(request.headers["webhook-timestamp"]);
  const expected = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${request.body}`).digest("base64")}`;
  return String(request.headers["webhook-signature"]).split(" ").includes(expected);
}

const ids = (requests: Received[]) => requests.map((r) => String(r.headers["webhook-id"]));

describe("fan-out and delivery", () => {
  it("delivers a matching event once, signed, and logs the attempt", async () => {
    const h = await harness();
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id, { types: ["turn.*"] });

    const eventId = await h.emit(t, started(app.id));
    const [request] = await eventually(
      "a delivery",
      () => h.endpoint.at(sub.path).length > 0 && h.endpoint.at(sub.path),
    );
    expect(request?.headers["webhook-id"]).toBe(eventId);
    expect(request && verify(sub.secret, request)).toBe(true);
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      id: eventId,
      v: 1,
      type: "turn.started",
      integrationId: app.id,
    });

    const attempts = await eventually("the attempt", async () => {
      const page = await listDeliveryAttempts(t.db, sub.id, { limit: 10 });
      return page.deliveries.length > 0 && page.deliveries;
    });
    expect(attempts).toMatchObject([
      {
        eventIds: [eventId],
        attempt: 1,
        outcome: "delivered",
        willRetry: false,
        status: 200,
        error: null,
        response: "ok",
      },
    ]);
    await sleep(600); // several sweeps
    expect(h.endpoint.at(sub.path)).toHaveLength(1);
  });

  it("delivers only matching types of its own integration, and everything with the tenant scope", async () => {
    const h = await harness();
    const t = await h.tenant();
    const a = await t.integration("a");
    const b = await t.integration("b", ["events", "tenant"]);
    const c = await t.integration("c", ["events"]);
    const own = await h.subscribe(t, a.id, { types: ["turn.*"] });
    const all = await h.subscribe(t, b.id, { types: ["*"], scope: "tenant" });
    // Asked for the tenant scope, but its integration lacks it (taken away later): only its own events.
    const demoted = await h.subscribe(t, c.id, { types: ["*"], scope: "tenant" });

    const aCreated = await h.emit(t, created(a.id));
    const aStarted = await h.emit(t, started(a.id));
    const bStarted = await h.emit(t, started(b.id));
    const consoleStarted = await h.emit(t, started(null));

    await eventually(
      "every event at the tenant-wide subscription",
      () => h.endpoint.at(all.path).length >= 4,
    );
    await sleep(600);
    expect(ids(h.endpoint.at(all.path)).sort()).toEqual(
      [aCreated, aStarted, bStarted, consoleStarted].sort(),
    );
    expect(ids(h.endpoint.at(own.path))).toEqual([aStarted]);
    expect(h.endpoint.at(demoted.path)).toEqual([]);
  });

  it("two dispatchers never deliver an event twice", async () => {
    const h = await harness();
    await h.dispatcher("second-dispatcher");
    const t = await h.tenant({ concurrentDeliveries: 10 });
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);

    const emitted: string[] = [];
    for (let i = 0; i < 12; i++) emitted.push(await h.emit(t, started(app.id, i + 1)));
    await eventually(
      "every event delivered",
      () => new Set(ids(h.endpoint.at(sub.path))).size === 12,
    );
    await sleep(600);
    expect(ids(h.endpoint.at(sub.path)).sort()).toEqual(emitted.sort());
    expect(await h.deliveryTasks(t)).toHaveLength(12);
  });

  it("retries a failing endpoint and records each attempt", async () => {
    const h = await harness();
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);
    let calls = 0;
    h.endpoint.answers.set(sub.path, () =>
      ++calls === 1 ? { status: 500, body: "down" } : { status: 200 },
    );

    const eventId = await h.emit(t, started(app.id));
    await eventually("the failed attempt", async () => {
      const page = await listDeliveryAttempts(t.db, sub.id, { limit: 10 });
      return page.deliveries.length === 1;
    });
    const failing = await getSubscription(h.control.db, t.id, sub.id);
    expect(failing?.failingSince).not.toBeNull();
    // The next attempt is 30 s out (DELIVERY_RETRY): bring it forward. The task is re-queued a moment after its attempt
    // is logged, so do it on every look, not once: a single update can land while the task still runs and match nothing.
    const attempts = await eventually("the retry", async () => {
      await t.db.query(
        "update absurd.r_deliveries set available_at = now() where state in ('pending', 'sleeping')",
      );
      const page = await listDeliveryAttempts(t.db, sub.id, { limit: 10 });
      return page.deliveries.length === 2 && page.deliveries;
    });
    expect(attempts).toMatchObject([
      { eventIds: [eventId], attempt: 2, outcome: "delivered", willRetry: false, status: 200 },
      {
        eventIds: [eventId],
        attempt: 1,
        outcome: "failed",
        willRetry: true,
        status: 500,
        error: "HTTP 500",
        response: "down",
      },
    ]);
    // The attempt is logged first, then the subscription marked healthy: two databases, so wait for the second.
    const healthy = await eventually("the subscription healthy again", async () => {
      const found = await getSubscription(h.control.db, t.id, sub.id);
      return found?.failingSince === null && found;
    });
    expect(healthy).toMatchObject({ state: "active", failingSince: null });
    expect(ids(h.endpoint.at(sub.path))).toEqual([eventId, eventId]);
  });

  it("disables a subscription whose endpoint answers 410, and delivers nothing more to it", async () => {
    const h = await harness();
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);
    h.endpoint.answers.set(sub.path, () => ({ status: 410 }));

    await h.emit(t, started(app.id));
    const disabled = await eventually("the subscription disabled", async () => {
      const found = await getSubscription(h.control.db, t.id, sub.id);
      return found?.state === "disabled" && found;
    });
    expect(disabled.disabledReason).toBe("the endpoint answered 410 Gone");
    const page = await listDeliveryAttempts(t.db, sub.id, { limit: 10 });
    expect(page.deliveries).toMatchObject([{ outcome: "gone", willRetry: false, status: 410 }]);

    await h.emit(t, started(app.id, 2));
    await sleep(600);
    expect(h.endpoint.at(sub.path)).toHaveLength(1);
    expect(await h.deliveryTasks(t)).toEqual(["completed"]);
  });

  it("disables a subscription that has failed for 48 hours, without retrying", async () => {
    const h = await harness();
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);
    h.endpoint.answers.set(sub.path, () => ({ status: 503 }));
    await h.control.db.query(
      "update subscriptions set failing_since = now() - interval '49 hours' where id = $1",
      [sub.id],
    );

    await h.emit(t, started(app.id));
    const disabled = await eventually("the subscription disabled", async () => {
      const found = await getSubscription(h.control.db, t.id, sub.id);
      return found?.state === "disabled" && found;
    });
    expect(disabled.disabledReason).toBe("every delivery failed for 48 hours");
    const attempts = await eventually("the attempt", async () => {
      const page = await listDeliveryAttempts(t.db, sub.id, { limit: 10 });
      return page.deliveries.length > 0 && page.deliveries;
    });
    expect(attempts).toMatchObject([{ outcome: "failed", willRetry: false, status: 503 }]);
    expect(
      await eventually("the task ended", async () => (await h.deliveryTasks(t))[0] === "completed"),
    ).toBe(true);
  });

  /** A subscription with one delivery queued for it, as fan-out would have left it. */
  async function queuedDelivery(h: Awaited<ReturnType<typeof harness>>) {
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);
    const eventId = await h.emit(t, started(app.id), false);
    await t.db.transaction((tx) =>
      spawnInTx(
        tx,
        "deliver-events",
        { subscriptionId: sub.id, eventIds: [eventId] },
        { idempotencyKey: `deliver:${sub.id}:${eventId}`, ...DELIVERY_RETRY },
      ),
    );
    return { t, sub };
  }

  it("finishes deleting a subscription, its tenant's last: cancels its deliveries, drops its cursor, removes it", async () => {
    const h = await harness({ start: false });
    const { t, sub } = await queuedDelivery(h);
    await t.db.transaction((tx) => lockCursor(tx, sub.id));
    await deleteSubscription(h.control.db, t.id, sub.id);

    const scheduler = await h.dispatcher();
    scheduler.notify(t.id);
    await eventually(
      "the task cancelled",
      async () => (await h.deliveryTasks(t))[0] === "cancelled",
    );
    await eventually(
      "the tombstone removed",
      async () =>
        (await h.control.db.query("select 1 from subscriptions where id = $1", [sub.id]))
          .rowCount === 0,
    );
    expect(
      (await t.db.query("select 1 from subscription_cursors where subscription_id = $1", [sub.id]))
        .rowCount,
    ).toBe(0);
    expect(h.endpoint.received).toEqual([]);
  });

  it("drops a queued delivery of a disabled subscription", async () => {
    const h = await harness({ start: false });
    const { t, sub } = await queuedDelivery(h);
    await updateSubscription(h.control.db, t.id, sub.id, { enabled: false });
    const lines: Record<string, unknown>[] = [];
    configureLogging({ write: (line) => lines.push(JSON.parse(line)) });
    cleanups.push(() => configureLogging({ write: (line) => process.stdout.write(line) }));

    const scheduler = await h.dispatcher();
    scheduler.notify(t.id);
    await eventually("the task ended", async () => (await h.deliveryTasks(t))[0] === "completed");
    expect(h.endpoint.received).toEqual([]);
    expect(
      lines.some(
        (line) => String(line.msg).startsWith("delivery dropped") && line.tenantId === t.id,
      ),
    ).toBe(true);
  });

  it("delivers a ping, signed, in the shape of an event", async () => {
    const h = await harness();
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id, { types: ["judgment.*"] });
    const ping = { id: randomUUID(), createdAt: new Date().toISOString() };
    await t.db.transaction((tx) =>
      spawnInTx(
        tx,
        "deliver-events",
        { subscriptionId: sub.id, ping },
        { idempotencyKey: `ping:${sub.id}:${ping.id}`, ...DELIVERY_RETRY },
      ),
    );
    await h.control.db.query("select pg_notify('tenant_events', $1)", [t.id]);

    const [request] = await eventually(
      "the ping",
      () => h.endpoint.at(sub.path).length > 0 && h.endpoint.at(sub.path),
    );
    expect(request?.headers["webhook-id"]).toBe(ping.id);
    expect(request && verify(sub.secret, request)).toBe(true);
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      id: ping.id,
      v: 1,
      type: "ping",
      createdAt: ping.createdAt,
      integrationId: app.id,
      data: {},
    });
  });
});

describe("scheduling", () => {
  it("keeps a tenant under its concurrent deliveries", async () => {
    const h = await harness();
    const t = await h.tenant({ concurrentDeliveries: 2 });
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);
    h.endpoint.answers.set(sub.path, () => ({ status: 200, delayMs: 200 }));

    for (let i = 0; i < 6; i++) await h.emit(t, started(app.id, i + 1));
    await eventually("every delivery", () => h.endpoint.at(sub.path).length === 6);
    expect(h.endpoint.maxInFlight()).toBe(2);
  });

  it("delivers promptly on a notification, not only at the sweep", async () => {
    const h = await harness({ settings: { sweepIntervalMs: 60_000 } });
    const t = await h.tenant();
    const app = await t.integration("app");
    const sub = await h.subscribe(t, app.id);

    const quiet = await h.emit(t, started(app.id), false);
    await sleep(500);
    expect(h.endpoint.at(sub.path)).toEqual([]);

    const announced = Date.now();
    const loud = await h.emit(t, started(app.id, 2));
    await eventually("both delivered", () => h.endpoint.at(sub.path).length === 2, 3_000);
    expect(Date.now() - announced).toBeLessThan(3_000);
    expect(ids(h.endpoint.at(sub.path)).sort()).toEqual([quiet, loud].sort());
  });
});

describe("dispatcher config", () => {
  const base = {
    CONTROL_DATABASE_URL: "postgres://x",
    TENANT_DB_KEYS: "k",
    DELIVERY_SECRETS_PRIVATE_KEYS: "p",
  };
  const parse = (env: Record<string, string>) =>
    dispatcherConfigSchema.safeParse({
      controlDatabaseUrl: env.CONTROL_DATABASE_URL,
      tenantDbKeys: env.TENANT_DB_KEYS,
      deliverySecretsPrivateKeys: env.DELIVERY_SECRETS_PRIVATE_KEYS,
      allowLocalDestinations: env.ALLOW_LOCAL_DESTINATIONS,
    });

  it("refuses local destinations unless the install allows them", () => {
    expect(parse(base).data?.allowLocalDestinations).toBe(false);
    expect(parse({ ...base, ALLOW_LOCAL_DESTINATIONS: "true" }).data?.allowLocalDestinations).toBe(
      true,
    );
  });

  it("requires the delivery secrets private key and caps 20 deliveries by default", () => {
    expect(parse({ ...base, DELIVERY_SECRETS_PRIVATE_KEYS: "" }).success).toBe(false);
    expect(parse(base).data?.maxRunningDeliveries).toBe(20);
  });
});
