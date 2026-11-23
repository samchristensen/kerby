import type { AgentMessage } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import { createTenantExecutor, type RunContext } from "@kerby/durable";
import { readEvents } from "@kerby/events";
import { describe, expect, it } from "vitest";
import {
  findConversation,
  insertConversation,
  isBusy,
  listConversations,
  persistMessage,
  postUserMessage,
  recordTurnOutcome,
  recordTurnStarted,
} from "./index.ts";
import { createTestTenant, type TestTenant } from "./testing.ts";

const QUOTA = { storageBytes: 1024 ** 3 };
const CRM = "6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11";
const OTHER = "0b7a9c3e-1f2d-4e5a-8b6c-7d8e9f0a1b2c";
const assistant = (value: string): AgentMessage => ({
  role: "assistant",
  model: "faux/faux-1",
  stopReason: "end",
  content: [{ type: "text", text: value }],
});

/**
 * Every event in the log, as the tenant sees it. The horizon is cluster-wide: another test file's open transaction may
 * hold recent events back for a moment, so read until the cursor has passed the newest one.
 */
async function events(tenant: TestTenant) {
  const { rows } = await tenant.db.query<{ tx: string | null }>(
    "select max(tx)::text as tx from events",
  );
  const newest = BigInt(rows[0]?.tx ?? "0");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const page = await readEvents(tenant.db, undefined, { visibility: "tenant" }, 1000);
    if (BigInt(page.next.split(".")[0] ?? "0") > newest || Date.now() > deadline)
      return page.events;
    // Real time: the horizon moves when another connection's transaction ends, which nothing here can signal.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

/** Claim the conversation's turn and run `fn` under it, as a worker would. */
async function withRun<T>(tenant: TestTenant, fn: (run: RunContext) => Promise<T>): Promise<T> {
  let result: T | undefined;
  const executor = createTenantExecutor(
    tenant.db,
    {
      "run-turn": async (_params, run) => {
        result = await fn(run);
      },
    },
    { workerId: "w" },
  );
  const [task] = (await executor.claim(1)).tasks;
  if (!task) throw new Error("no turn to claim");
  await executor.execute(task);
  return result as T;
}

async function posted(tenant: TestTenant, integrationId: string | null = CRM) {
  const blobs = await createTestBlobs();
  const conversation = await insertConversation(tenant.db, {
    integrationId,
    model: "faux/faux-1",
    system: "",
  });
  const { seq } = await postUserMessage(
    tenant,
    blobs,
    conversation.id,
    [{ type: "text", text: "hello" }],
    QUOTA,
  );
  return { blobs, conversation, seq };
}

describe("conversation and message events", () => {
  it("records conversation.created and message.created with the integration, once each", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation, seq } = await posted(tenant);
    expect(conversation.integrationId).toBe(CRM);
    await withRun(tenant, async (run) => {
      const input = {
        conversationId: conversation.id,
        seq: seq + 1,
        message: assistant("hi"),
        run,
      };
      expect(await persistMessage(tenant, blobs, input)).toBe("inserted");
      // a retried persist of the same message records nothing more
      expect(await persistMessage(tenant, blobs, input)).toBe("exists");
    });
    const log = await events(tenant);
    expect(log.map((e) => [e.type, e.integrationId, e.data])).toEqual([
      ["conversation.created", CRM, expect.objectContaining({ conversationId: conversation.id })],
      ["message.created", CRM, { conversationId: conversation.id, seq, role: "user" }],
      [
        "message.created",
        CRM,
        { conversationId: conversation.id, seq: seq + 1, role: "assistant" },
      ],
    ]);
  });

  it("records a console conversation's events without an integration", async () => {
    await using tenant = await createTestTenant();
    await posted(tenant, null);
    expect((await events(tenant)).map((e) => e.integrationId)).toEqual([null, null]);
  });
});

describe("visibility", () => {
  it("hides another integration's conversations; the tenant sees all", async () => {
    await using tenant = await createTestTenant();
    const mine = await insertConversation(tenant.db, {
      integrationId: CRM,
      model: "m",
      system: "",
    });
    const theirs = await insertConversation(tenant.db, {
      integrationId: OTHER,
      model: "m",
      system: "",
    });
    const consoles = await insertConversation(tenant.db, {
      integrationId: null,
      model: "m",
      system: "",
    });
    const crm = { integrationId: CRM };
    expect((await findConversation(tenant.db, mine.id, crm))?.id).toBe(mine.id);
    expect(await findConversation(tenant.db, theirs.id, crm)).toBeUndefined();
    expect(await findConversation(tenant.db, consoles.id, crm)).toBeUndefined();
    expect((await findConversation(tenant.db, theirs.id, "tenant"))?.id).toBe(theirs.id);

    const ids = async (visibility: Parameters<typeof listConversations>[2]) =>
      (await listConversations(tenant.db, { limit: 10 }, visibility)).conversations
        .map((c) => c.id)
        .sort();
    expect(await ids(crm)).toEqual([mine.id]);
    expect(await ids("tenant")).toEqual([mine.id, theirs.id, consoles.id].sort());
  });
});

describe("turn outcomes", () => {
  it("records nothing for a run that lost its lease", async () => {
    await using tenant = await createTestTenant();
    const { conversation, seq } = await posted(tenant);
    await withRun(tenant, async (run) => {
      const stale = { ...run, runId: "00000000-0000-4000-8000-000000000000" };
      expect(
        await recordTurnOutcome(tenant, {
          conversation,
          seq,
          run: stale,
          outcome: { type: "failed", reason: "error", error: "boom" },
        }),
      ).toBe(false);
    });
    expect((await events(tenant)).map((e) => e.type)).not.toContain("turn.failed");
    expect((await findConversation(tenant.db, conversation.id, "tenant"))?.lastError).toBeNull();
  });

  it("records one start and one outcome per turn however often they are called", async () => {
    await using tenant = await createTestTenant();
    const { conversation, seq } = await posted(tenant);
    await withRun(tenant, async (run) => {
      await recordTurnStarted(tenant, conversation, seq);
      await recordTurnStarted(tenant, conversation, seq);
      const outcome = { type: "completed" as const, lastSeq: seq };
      expect(await recordTurnOutcome(tenant, { conversation, seq, run, outcome })).toBe(true);
      expect(
        await recordTurnOutcome(tenant, {
          conversation,
          seq,
          run,
          outcome: { type: "blocked", lastSeq: seq, guardrails: ["x"] },
        }),
      ).toBe(true);
    });
    const turns = (await events(tenant)).filter((e) => e.type.startsWith("turn."));
    expect(turns.map((e) => [e.type, e.integrationId])).toEqual([
      ["turn.started", CRM],
      ["turn.completed", CRM],
    ]);
  });

  it("keeps a failure on the conversation until the next post", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation, seq } = await posted(tenant);
    await withRun(tenant, async (run) => {
      await recordTurnOutcome(tenant, {
        conversation,
        seq,
        run,
        outcome: { type: "failed", reason: "error", error: "the model refused" },
      });
    });
    expect((await findConversation(tenant.db, conversation.id, "tenant"))?.lastError).toBe(
      "the model refused",
    );
    const failed = (await events(tenant)).find((e) => e.type === "turn.failed");
    expect(failed?.data).toMatchObject({ seq, reason: "error", error: "the model refused" });

    await postUserMessage(tenant, blobs, conversation.id, [{ type: "text", text: "again" }], QUOTA);
    expect((await findConversation(tenant.db, conversation.id, "tenant"))?.lastError).toBeNull();
  });

  it("is not busy once the turn's outcome is recorded, while its task is still finishing", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation, seq } = await posted(tenant);
    await withRun(tenant, async (run) => {
      expect(await isBusy(tenant.db, conversation.id)).toBe(true);
      const outcome = { type: "completed" as const, lastSeq: seq };
      await recordTurnOutcome(tenant, { conversation, seq, run, outcome });
      // The task is still running here: a client acting on turn.completed must be able to post at once.
      expect(await isBusy(tenant.db, conversation.id)).toBe(false);
      const next = await postUserMessage(
        tenant,
        blobs,
        conversation.id,
        [{ type: "text", text: "next" }],
        QUOTA,
      );
      expect(next.seq).toBe(seq + 1);
      // ...and the new turn is busy until its own outcome.
      expect(await isBusy(tenant.db, conversation.id)).toBe(true);
    });
  });
});
