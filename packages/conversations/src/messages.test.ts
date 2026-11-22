import type { AgentMessage } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import { createTenantExecutor, type RunContext } from "@kerby/durable";
import { describe, expect, it } from "vitest";
import {
  ConversationBusyError,
  ConversationFullError,
  ConversationNotFoundError,
  conversationChannel,
  insertConversation,
  isBusy,
  LeaseLostError,
  MAX_CONVERSATION_BYTES,
  parseNotice,
  persistMessage,
  postUserMessage,
  readMessages,
  SeqConflictError,
} from "./index.ts";
import { createTestTenant, type TestTenant } from "./testing.ts";

const text = (value: string) => [{ type: "text", text: value }] as const;
const assistant = (value: string): AgentMessage => ({
  role: "assistant",
  model: "faux/faux-1",
  stopReason: "end",
  content: [...text(value)],
});

/** Claim the conversation's turn and hand its RunContext to `fn`: a real attempt, as a worker would hold it. */
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
  const [task] = await executor.claim(1);
  if (!task) throw new Error("no turn to claim");
  await executor.execute(task);
  return result as T;
}

async function conversationWithTurn(tenant: TestTenant) {
  const blobs = await createTestBlobs();
  const conversation = await insertConversation(tenant.db, { model: "faux/faux-1", system: "" });
  const posted = await postUserMessage(tenant, blobs, conversation.id, [...text("hello")]);
  return { blobs, conversation, posted };
}

describe("postUserMessage", () => {
  it("stores nothing when it refuses a post: a busy conversation, or a full one", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    const objects = async () => (await blobs.listPrefix(tenant.tenantId)).length;
    const indexed = async () =>
      Number(
        (await tenant.db.query<{ n: string }>("select count(*)::text as n from blobs")).rows[0]?.n,
      );
    const before = { objects: await objects(), indexed: await indexed() };

    await expect(
      postUserMessage(tenant, blobs, conversation.id, [...text("while busy")]),
    ).rejects.toBeInstanceOf(ConversationBusyError);
    expect({ objects: await objects(), indexed: await indexed() }).toEqual(before);

    // finish the turn, then claim the conversation already holds as many bytes as it may
    await withRun(tenant, async () => {});
    await tenant.db.query("update blobs set size = $1", [MAX_CONVERSATION_BYTES]);
    await expect(
      postUserMessage(tenant, blobs, conversation.id, [...text("one more")]),
    ).rejects.toBeInstanceOf(ConversationFullError);
    expect({ objects: await objects(), indexed: await indexed() }).toEqual(before);
  });

  it("appends the message and enqueues one turn, atomically visible", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation, posted } = await conversationWithTurn(tenant);
    expect(posted.seq).toBe(1);
    expect(await isBusy(tenant.db, conversation.id)).toBe(true);
    const stored = await readMessages(tenant, blobs, conversation.id);
    expect(stored.map((m) => m.message)).toEqual([{ role: "user", content: [...text("hello")] }]);
    const tasks = await tenant.db.query<{ params: unknown; idempotency_key: string }>(
      "select params, idempotency_key from absurd.t_turns",
    );
    expect(tasks.rows).toEqual([
      {
        params: { conversationId: conversation.id, seq: 1 },
        idempotency_key: `turn:${conversation.id}:1`,
      },
    ]);
  });

  it("announces the new message to listeners of the conversation", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "m", system: "" });
    const notices: string[] = [];
    const subscription = await tenant.db.listen(conversationChannel(conversation.id), (p) =>
      notices.push(p),
    );
    try {
      await postUserMessage(tenant, blobs, conversation.id, [...text("hi")]);
      for (let i = 0; i < 50 && notices.length === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(notices.map(parseNotice)).toEqual([{ persisted: 1 }]);
    } finally {
      await subscription.close();
    }
  });

  it("refuses a message while a turn is queued, and of a missing conversation", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    await expect(
      postUserMessage(tenant, blobs, conversation.id, [...text("again")]),
    ).rejects.toBeInstanceOf(ConversationBusyError);
    await expect(
      postUserMessage(tenant, blobs, "6f1c1d0e-9d38-4d9e-8c8e-0d6a4d4f1b11", [...text("x")]),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("lets exactly one of several concurrent posts win", async () => {
    await using tenant = await createTestTenant();
    const blobs = await createTestBlobs();
    const conversation = await insertConversation(tenant.db, { model: "m", system: "" });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        postUserMessage(tenant, blobs, conversation.id, [...text(`m${i}`)]),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => r.reason instanceof ConversationBusyError),
    ).toBe(true);
    expect((await tenant.db.query("select 1 from messages")).rowCount).toBe(1);
    expect((await tenant.db.query("select 1 from absurd.t_turns")).rowCount).toBe(1);
  });

  it("accepts the next message once the turn is over", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    await withRun(tenant, async (run) => {
      await persistMessage(tenant, blobs, {
        conversationId: conversation.id,
        seq: 2,
        message: assistant("hi"),
        run,
      });
    });
    expect(await isBusy(tenant.db, conversation.id)).toBe(false);
    expect((await postUserMessage(tenant, blobs, conversation.id, [...text("more")])).seq).toBe(3);
  });
});

describe("persistMessage", () => {
  it("is idempotent for the same content and announces the row once", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    const notices: string[] = [];
    const subscription = await tenant.db.listen(conversationChannel(conversation.id), (p) =>
      notices.push(p),
    );
    try {
      const outcomes = await withRun(tenant, async (run) => {
        const input = { conversationId: conversation.id, seq: 2, message: assistant("hi"), run };
        return [
          await persistMessage(tenant, blobs, input),
          await persistMessage(tenant, blobs, input),
        ];
      });
      expect(outcomes).toEqual(["inserted", "exists"]);
      for (let i = 0; i < 50 && notices.length === 0; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(notices.map(parseNotice)).toEqual([{ persisted: 2 }]);
    } finally {
      await subscription.close();
    }
    expect((await readMessages(tenant, blobs, conversation.id, 1)).map((m) => m.message)).toEqual([
      assistant("hi"),
    ]);
  });

  it("refuses different content at a taken position, leaving the stored bytes alone", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    await withRun(tenant, async (run) => {
      await persistMessage(tenant, blobs, {
        conversationId: conversation.id,
        seq: 2,
        message: assistant("first"),
        run,
      });
      await expect(
        persistMessage(tenant, blobs, {
          conversationId: conversation.id,
          seq: 2,
          message: assistant("divergent"),
          run,
        }),
      ).rejects.toBeInstanceOf(SeqConflictError);
    });
    expect((await readMessages(tenant, blobs, conversation.id, 1)).map((m) => m.message)).toEqual([
      assistant("first"),
    ]);
  });

  it("refuses a position that would leave a gap", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    await withRun(tenant, async (run) => {
      await expect(
        persistMessage(tenant, blobs, {
          conversationId: conversation.id,
          seq: 5,
          message: assistant("x"),
          run,
        }),
      ).rejects.toBeInstanceOf(SeqConflictError);
    });
  });

  it("refuses a run that is not the task's current attempt", async () => {
    await using tenant = await createTestTenant();
    const { blobs, conversation } = await conversationWithTurn(tenant);
    await withRun(tenant, async (run) => {
      const stale = { ...run, runId: "00000000-0000-4000-8000-000000000000" };
      await expect(
        persistMessage(tenant, blobs, {
          conversationId: conversation.id,
          seq: 2,
          message: assistant("x"),
          run: stale,
        }),
      ).rejects.toBeInstanceOf(LeaseLostError);
    });
    expect((await tenant.db.query("select 1 from messages")).rowCount).toBe(1);
  });
});

describe("parseNotice", () => {
  it("accepts persisted pointers and valid live envelopes, and nothing else", () => {
    expect(parseNotice('{"persisted":3}')).toEqual({ persisted: 3 });
    expect(parseNotice("not json")).toBeUndefined();
    expect(parseNotice('{"live":{"v":2}}')).toBeUndefined();
    expect(parseNotice('{"other":1}')).toBeUndefined();
  });
});
