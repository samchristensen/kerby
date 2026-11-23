import { randomUUID } from "node:crypto";
import type { PublicEvent } from "@kerby/contracts";
import { type ClosableTenantDb, createTenantDb } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { describe, expect, it } from "vitest";
import {
  type EventFilter,
  eventsHeldBack,
  eventsMigrationsDir,
  findEvents,
  listDeliveryAttempts,
  lockCursor,
  type NewEvent,
  pollEvents,
  pruneEvents,
  readEvents,
  recordDeliveryAttempt,
  recordEvent,
  saveCursor,
} from "./index.ts";

const CRM = "6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11";
const OTHER = "0b7a9c3e-1f2d-4e5a-8b6c-7d8e9f0a1b2c";
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const TENANT: EventFilter = { visibility: "tenant" };

async function createLog(): Promise<{ db: ClosableTenantDb } & AsyncDisposable> {
  const database = await createMigratedDatabase([eventsMigrationsDir]);
  const db = createTenantDb(database.url, { max: 5 });
  return {
    db,
    async [Symbol.asyncDispose]() {
      await db.close();
      await database.drop();
    },
  };
}

let seq = 0;
/** A message.created event; `seq` names it in assertions. */
function message(
  options: { integrationId?: string | null; conversationId?: string; dedupeKey?: string } = {},
): NewEvent & { type: "message.created" } {
  seq += 1;
  return {
    type: "message.created",
    integrationId: options.integrationId === undefined ? CRM : options.integrationId,
    dedupeKey: options.dedupeKey ?? `message:${seq}`,
    data: { conversationId: options.conversationId ?? CONVERSATION, seq, role: "user" },
  };
}

const seqs = (events: PublicEvent[]) =>
  events.map((event) => ("seq" in event.data ? event.data.seq : undefined));

/**
 * Read until `done` holds. The horizon is cluster-wide: a transaction of another test file running on the same server
 * may hold it back for a moment, which delays (never reorders) what a read returns.
 */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    // Real time: the horizon moves when another connection's transaction ends, which nothing here can signal.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

const cursorTx = (cursor: string) => BigInt(cursor.split(".")[0] ?? "0");

describe("readEvents", () => {
  it("never skips an event whose transaction commits after a later one", async () => {
    await using log = await createLog();
    const early = message();
    const late = message();
    const gate = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    // the earlier transaction records its event, then stays open
    const open = log.db.transaction(async (tx) => {
      await recordEvent(tx, early);
      recorded.resolve();
      await gate.promise;
    });
    await recorded.promise;
    // a later transaction records and commits
    await log.db.transaction((tx) => recordEvent(tx, late));

    const first = await readEvents(log.db, undefined, TENANT, 100);
    // the committed later event is held back while the earlier transaction may still commit before it
    expect(first.events).toEqual([]);
    // ...and a reader can tell, so it looks again instead of waiting for a notification already sent
    expect(await eventsHeldBack(log.db)).toBe(true);

    gate.resolve();
    await open;
    const rest = await eventually(
      () => readEvents(log.db, first.next, TENANT, 100),
      (page) => page.events.length >= 2,
    );
    expect(seqs(rest.events)).toEqual([early.data.seq, late.data.seq]);
    expect((await readEvents(log.db, rest.next, TENANT, 100)).events).toEqual([]);
    expect(
      await eventually(
        () => eventsHeldBack(log.db),
        (held) => !held,
      ),
    ).toBe(false);
  });

  it("records an event once per dedupe key", async () => {
    await using log = await createLog();
    const event = message({ dedupeKey: "message:x:1" });
    expect(await log.db.transaction((tx) => recordEvent(tx, event))).toBe(true);
    expect(await log.db.transaction((tx) => recordEvent(tx, { ...event }))).toBe(false);
    const page = await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length > 0,
    );
    expect(page.events).toHaveLength(1);
  });

  it("shows an integration its own events, the tenant all of them", async () => {
    await using log = await createLog();
    const mine = message();
    const theirs = message({ integrationId: OTHER });
    const consoles = message({ integrationId: null });
    for (const event of [mine, theirs, consoles])
      await log.db.transaction((tx) => recordEvent(tx, event));
    const all = await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length === 3,
    );
    expect(all.events.map((e) => e.integrationId)).toEqual([CRM, OTHER, null]);
    const own = await readEvents(log.db, undefined, { visibility: { integrationId: CRM } }, 100);
    expect(seqs(own.events)).toEqual([mine.data.seq]);
  });

  it("moves the cursor past events a filter skips, so the next read does not scan them again", async () => {
    await using log = await createLog();
    const skipped = [message(), message(), message()];
    for (const event of skipped) await log.db.transaction((tx) => recordEvent(tx, event));
    const { rows } = await log.db.query<{ tx: string }>("select max(tx)::text as tx from events");
    const newest = BigInt(rows[0]?.tx ?? "0");
    const filter: EventFilter = { visibility: "tenant", types: ["turn.started"] };
    const quiet = await eventually(
      () => readEvents(log.db, undefined, filter, 100),
      (p) => cursorTx(p.next) > newest,
    );
    expect(quiet.events).toEqual([]);
    expect(cursorTx(quiet.next)).toBeGreaterThan(newest);
    // nothing behind the cursor comes back, whatever the filter
    expect((await readEvents(log.db, quiet.next, TENANT, 100)).events).toEqual([]);

    await log.db.transaction((tx) =>
      recordEvent(tx, {
        type: "turn.started",
        integrationId: CRM,
        dedupeKey: "turn:1:started",
        data: { conversationId: CONVERSATION, seq: 1 },
      }),
    );
    const next = await eventually(
      () => readEvents(log.db, quiet.next, filter, 100),
      (p) => p.events.length > 0,
    );
    expect(next.events.map((e) => e.type)).toEqual(["turn.started"]);
  });

  it("filters by conversation", async () => {
    await using log = await createLog();
    const other = randomUUID();
    const wanted = message({ conversationId: other });
    for (const event of [message(), wanted, message()])
      await log.db.transaction((tx) => recordEvent(tx, event));
    const page = await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length === 3,
    );
    expect(page.events).toHaveLength(3);
    const only = await readEvents(log.db, undefined, { ...TENANT, conversationId: other }, 100);
    expect(seqs(only.events)).toEqual([wanted.data.seq]);
  });

  it("pages by limit, each page continuing where the last stopped", async () => {
    await using log = await createLog();
    const events = [message(), message(), message(), message(), message()];
    for (const event of events) await log.db.transaction((tx) => recordEvent(tx, event));
    await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length === 5,
    );
    const seen: (number | undefined)[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await readEvents(log.db, cursor, TENANT, 2);
      seen.push(...seqs(result.events));
      cursor = result.next;
    }
    expect(seen).toEqual(events.map((e) => e.data.seq));
  });
});

describe("pollEvents", () => {
  it("returns as soon as an event commits during the wait", async () => {
    await using log = await createLog();
    const start = await readEvents(log.db, undefined, TENANT, 100);
    const event = message();
    const began = Date.now();
    const polling = pollEvents(
      log.db,
      start.next,
      TENANT,
      100,
      20_000,
      new AbortController().signal,
    );
    setTimeout(() => void log.db.transaction((tx) => recordEvent(tx, event)), 200);
    const page = await polling;
    expect(seqs(page.events)).toEqual([event.data.seq]);
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("returns empty once the wait passes", async () => {
    await using log = await createLog();
    const began = Date.now();
    const page = await pollEvents(
      log.db,
      undefined,
      TENANT,
      100,
      300,
      new AbortController().signal,
    );
    expect(page.events).toEqual([]);
    expect(Date.now() - began).toBeGreaterThanOrEqual(290);
  });

  it("returns empty early when aborted", async () => {
    await using log = await createLog();
    const abort = new AbortController();
    const began = Date.now();
    setTimeout(() => abort.abort(), 100);
    const page = await pollEvents(log.db, undefined, TENANT, 100, 20_000, abort.signal);
    expect(page.events).toEqual([]);
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});

describe("subscription cursors", () => {
  it("starts a new subscription at now, and keeps where it saved", async () => {
    await using log = await createLog();
    const before = message();
    await log.db.transaction((tx) => recordEvent(tx, before));
    // wait until the earlier event is behind the horizon, so the cursor starts after it
    await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length === 1,
    );
    const subscription = randomUUID();
    const cursor = await log.db.transaction((tx) => lockCursor(tx, subscription));
    const after = message();
    await log.db.transaction((tx) => recordEvent(tx, after));
    const page = await eventually(
      () => readEvents(log.db, cursor, TENANT, 100),
      (p) => p.events.length > 0,
    );
    expect(seqs(page.events)).toEqual([after.data.seq]);

    await log.db.transaction(async (tx) => {
      expect(await lockCursor(tx, subscription)).toBe(cursor);
      await saveCursor(tx, subscription, page.next);
    });
    expect(await log.db.transaction((tx) => lockCursor(tx, subscription))).toBe(page.next);
  });
});

describe("findEvents", () => {
  it("returns the visible ones of the ids asked, in log order", async () => {
    await using log = await createLog();
    const a = message();
    const b = message({ integrationId: OTHER });
    const c = message();
    for (const event of [a, b, c]) await log.db.transaction((tx) => recordEvent(tx, event));
    const all = await eventually(
      () => readEvents(log.db, undefined, TENANT, 100),
      (p) => p.events.length === 3,
    );
    const ids = all.events.map((e) => e.id).reverse();
    expect(seqs(await findEvents(log.db, [...ids, randomUUID()], "tenant"))).toEqual([
      a.data.seq,
      b.data.seq,
      c.data.seq,
    ]);
    expect(seqs(await findEvents(log.db, ids, { integrationId: CRM }))).toEqual([
      a.data.seq,
      c.data.seq,
    ]);
  });
});

const failedAttempt = (subscriptionId: string, n: number) => ({
  subscriptionId,
  eventIds: [randomUUID()],
  attempt: n,
  outcome: "failed" as const,
  willRetry: true,
  status: 500,
  error: "server error",
  response: "oops",
  durationMs: 12,
});

describe("delivery attempts", () => {
  it("lists a subscription's attempts newest first, a page at a time", async () => {
    await using log = await createLog();
    const subscription = randomUUID();
    for (const n of [1, 2, 3]) await recordDeliveryAttempt(log.db, failedAttempt(subscription, n));
    await recordDeliveryAttempt(log.db, failedAttempt(randomUUID(), 9));
    const first = await listDeliveryAttempts(log.db, subscription, { limit: 2 });
    expect(first.deliveries.map((d) => d.attempt)).toEqual([3, 2]);
    expect(first.nextBefore).not.toBeNull();
    const second = await listDeliveryAttempts(log.db, subscription, {
      limit: 2,
      before: first.nextBefore ?? undefined,
    });
    expect(second.deliveries.map((d) => d.attempt)).toEqual([1]);
    expect(second.nextBefore).toBeNull();
    expect(second.deliveries[0]).toMatchObject({ outcome: "failed", status: 500, durationMs: 12 });
  });
});

describe("pruneEvents", () => {
  it("deletes only events and attempts older than the retention", async () => {
    await using log = await createLog();
    const old = message();
    const recent = message();
    for (const event of [old, recent]) await log.db.transaction((tx) => recordEvent(tx, event));
    const subscription = randomUUID();
    await recordDeliveryAttempt(log.db, failedAttempt(subscription, 1));
    await recordDeliveryAttempt(log.db, failedAttempt(subscription, 2));
    await log.db.query(
      "update events set created_at = now() - interval '2 days' where dedupe_key = $1",
      [old.dedupeKey],
    );
    await log.db.query(
      "update delivery_attempts set at = now() - interval '2 days' where attempt = 1",
    );
    expect(await pruneEvents(log.db, 24 * 3_600_000)).toEqual({ events: 1, attempts: 1 });
    const left = await log.db.query<{ dedupe_key: string }>("select dedupe_key from events");
    expect(left.rows.map((r) => r.dedupe_key)).toEqual([recent.dedupeKey]);
    const attempts = await listDeliveryAttempts(log.db, subscription, { limit: 10 });
    expect(attempts.deliveries.map((d) => d.attempt)).toEqual([2]);
  });
});
