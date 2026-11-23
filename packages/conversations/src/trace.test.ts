import { createTestBlobs } from "@kerby/blobs/testing";
import type { TraceEntry, TraceEvent } from "@kerby/contracts";
import { describe, expect, it } from "vitest";
import { appendTrace, insertConversation, readTrace } from "./index.ts";
import { createTestTenant } from "./testing.ts";

const entry = (runId: string, n: number, event: TraceEvent): TraceEntry => ({
  runId,
  attempt: 1,
  n,
  at: "2026-11-23T10:00:00.000Z",
  event,
});

describe("trace", () => {
  it("reads back what runs reported, in the order it was recorded, across runs", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });

    await appendTrace(tenant, blobs, conversation.id, [
      entry("run-a", 1, { type: "run_start" }),
      entry("run-a", 2, { type: "thinking_end", text: "plan the call" }),
    ]);
    await appendTrace(tenant, blobs, conversation.id, [
      entry("run-a", 3, { type: "message_end", seq: 2, role: "assistant" }),
    ]);
    // The retry is a different run, and its entries start again at 1.
    await appendTrace(tenant, blobs, conversation.id, [
      { ...entry("run-b", 1, { type: "run_start" }), attempt: 2 },
    ]);

    const page = await readTrace(tenant, blobs, conversation.id, { after: 0, limit: 100 });
    expect(page.nextAfter).toBeNull();
    expect(page.entries.map((e) => [e.runId, e.attempt, e.n, e.event.type])).toEqual([
      ["run-a", 1, 1, "run_start"],
      ["run-a", 1, 2, "thinking_end"],
      ["run-a", 1, 3, "message_end"],
      ["run-b", 2, 1, "run_start"],
    ]);
    expect(page.entries[1]?.event).toEqual({ type: "thinking_end", text: "plan the call" });
  });

  it("pages at whole segments, so every entry is returned once", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
    await appendTrace(tenant, blobs, conversation.id, [
      entry("r", 1, { type: "run_start" }),
      entry("r", 2, { type: "message_start", role: "assistant" }),
      entry("r", 3, { type: "thinking_end", text: "a" }),
    ]);
    await appendTrace(tenant, blobs, conversation.id, [
      entry("r", 4, { type: "message_end", seq: 2, role: "assistant" }),
    ]);
    await appendTrace(tenant, blobs, conversation.id, [
      entry("r", 5, { type: "run_end", reason: "done" }),
    ]);

    const seen: number[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await readTrace(tenant, blobs, conversation.id, { after, limit: 2 });
      pages++;
      seen.push(...page.entries.map((e) => e.n));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // limit 2: the first segment already holds 3 entries, then 4 and 5 fill the next page.
    expect(pages).toBe(2);
  });

  it("keeps recorded order past ten segments, whole and in pages", async () => {
    // Segment ids 1 to 12: sorted as text, 10 would come before 7.
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
    for (let n = 1; n <= 12; n++)
      await appendTrace(tenant, blobs, conversation.id, [
        entry("r", n, { type: "message_start", role: "assistant" }),
      ]);

    const whole = await readTrace(tenant, blobs, conversation.id, { after: 0, limit: 100 });
    expect(whole.entries.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = await readTrace(tenant, blobs, conversation.id, { after, limit: 5 });
      seen.push(...page.entries.map((e) => e.n));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("keeps one conversation's trace apart from another's, and counts its bytes as stored", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const mine = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
    const other = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
    await appendTrace(tenant, blobs, mine.id, [entry("r", 1, { type: "run_start" })]);

    expect((await readTrace(tenant, blobs, other.id, { after: 0, limit: 10 })).entries).toEqual([]);
    const { rows } = await tenant.db.query<{ size: string }>(
      "select coalesce(sum(size), 0)::text as size from blobs where kind = 'trace'",
    );
    expect(Number(rows[0]?.size)).toBeGreaterThan(0);
  });

  it("refuses a segment that is not one run's consecutive entries", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
    await expect(
      appendTrace(tenant, blobs, conversation.id, [
        entry("r", 1, { type: "run_start" }),
        entry("r", 3, { type: "run_end", reason: "done" }),
      ]),
    ).rejects.toThrow(RangeError);
    await expect(
      appendTrace(tenant, blobs, conversation.id, [
        entry("r", 1, { type: "run_start" }),
        entry("other", 2, { type: "run_end", reason: "done" }),
      ]),
    ).rejects.toThrow(RangeError);
  });
});
