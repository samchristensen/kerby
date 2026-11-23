// The chat search index from the worker's side (ADR 0021): what a finished turn leaves in the index, what a semantic
// search answers with and without the tenant's key, and the backfill a model change starts. Real Postgres, RustFS and
// scheduler; embeddings from the deterministic fake, which ranks texts that share words closer.
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentMessage } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import { insertTenant, setTenantStatus } from "@kerby/control-plane";
import { createTestControlDb } from "@kerby/control-plane/testing";
import { insertConversation, isBusy, postUserMessage } from "@kerby/conversations";
import { completeTurnWith, createTestTenant } from "@kerby/conversations/testing";
import { type TenantContext, TenantPools } from "@kerby/db";
import { readTask, spawnInTx, type TaskParams } from "@kerby/durable";
import { createFakeEmbeddings } from "@kerby/embeddings/fake";
import { indexCounts, readSearchSettings, setEmbeddingModel } from "@kerby/search";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDevelopmentRuntime,
  createHandlers,
  createScheduler,
  toolFetches,
  type WorkerDeps,
} from "./index.ts";

const MODEL = "fake/hash-256";

const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A worker over one tenant. Its scheduler starts when the test says, so a test can lay out data no turn touches. */
async function harness(options: { modelKeys?: WorkerDeps["modelKeys"] } = {}) {
  const control = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const blobs = await createTestBlobs();
  const database = await createTestTenant();
  cleanups.push(() => database[Symbol.asyncDispose]());
  const row = await insertTenant(control.db, { name: "searcher", dbHost: "h", dbPort: 1 });
  await setTenantStatus(control.db, row.id, "active");
  const pools = new TenantPools({
    resolveUrl: async (id) =>
      id === row.id ? database.url : Promise.reject(new Error(`unknown tenant ${id}`)),
  });
  cleanups.push(() => pools.close());
  const deps: WorkerDeps = {
    control: control.db,
    pools,
    blobs,
    runtime: createDevelopmentRuntime(),
    modelKeys: options.modelKeys,
    judgments: [],
    // The fake, and the fake again standing in for a real provider whose key a tenant may lack.
    embeddings: [createFakeEmbeddings(), { ...createFakeEmbeddings(), id: "openai" }],
    toolCredentials: undefined,
    ...toolFetches({ toolCallTimeoutMs: 60_000, allowedHosts: [] }),
    settings: {
      workerId: "search-worker",
      claimTimeoutSeconds: 30,
      defaultMaxConcurrentTurns: 4,
      maxRunningTurns: 50,
      maxRunningIndexTasks: 2,
      maxRunningSearches: 4,
      sweepIntervalMs: 200,
      // Out of reach of a test: work no hint announced is found only by the full sweep at start.
      fullSweepIntervalMs: 600_000,
      enableEchoTool: true,
      historyBudgetBytes: 8 * 1024 * 1024,
      toolCallTimeoutMs: 60_000,
    },
  };
  const ctx: TenantContext = { tenantId: row.id, db: database.db };
  const notify = () => control.db.query("select pg_notify('tenant_work', $1)", [row.id]);

  return {
    ctx,
    blobs,
    async start() {
      const scheduler = createScheduler(deps, createHandlers(deps));
      await scheduler.start();
      cleanups.push(() => scheduler.stop(0));
    },
    async useModel(model: string | null) {
      return ctx.db.transaction((tx) => setEmbeddingModel(tx, model));
    },
    /** A conversation answered by a real turn (the fake model replies "Echo: <text>"). */
    async chat(text: string) {
      const conversation = await insertConversation(ctx.db, {
        model: "fake/fake-1",
        system: "",
        integrationId: null,
      });
      await postUserMessage(ctx, blobs, conversation.id, [{ type: "text", text }], {
        storageBytes: 1024 ** 3,
      });
      await notify();
      await eventually("the turn", async () => !(await isBusy(ctx.db, conversation.id)));
      return conversation.id;
    },
    /** A conversation whose messages are stored without the worker (no turn, so nothing indexes it). */
    async stored(text: string) {
      const conversation = await insertConversation(ctx.db, {
        model: "fake/fake-1",
        system: "",
        integrationId: null,
      });
      await postUserMessage(ctx, blobs, conversation.id, [{ type: "text", text }], {
        storageBytes: 1024 ** 3,
      });
      const reply: AgentMessage = {
        role: "assistant",
        model: "fake/fake-1",
        stopReason: "end",
        content: [{ type: "text", text: `Echo: ${text}` }],
      };
      await completeTurnWith(ctx, blobs, conversation.id, [reply]);
      return conversation.id;
    },
    async spawn<N extends "index-conversation" | "index-backfill" | "run-search">(
      name: N,
      params: TaskParams[N],
      key: string,
    ) {
      const { taskId } = await ctx.db.transaction((tx) =>
        spawnInTx(tx, name, params, { idempotencyKey: key, maxAttempts: 1 }),
      );
      await notify();
      return taskId;
    },
    async search(query: string) {
      const taskId = await this.spawn(
        "run-search",
        { query, limit: 10, externalUserId: null, visibility: "tenant" },
        `search:${crypto.randomUUID()}`,
      );
      const task = await eventually("the search", async () => {
        const found = await readTask(ctx.db, "run-search", taskId);
        return found?.state === "completed" && found;
      });
      if (!task.result) throw new Error("a completed search has a result");
      return task.result;
    },
  };
}

describe("chat search in the worker", () => {
  it("indexes a finished turn and finds it by words and meaning", async () => {
    const h = await harness();
    await h.start();
    await h.useModel(MODEL);
    const giraffes = await h.chat("the giraffe migration crosses the river at dawn");
    await h.chat("quarterly invoice totals for the accounting team");

    // Two turns, a user message and an answer each: four chunks, all embedded with the tenant's model.
    await eventually("every chunk embedded", async () => {
      const counts = await indexCounts(h.ctx.db, MODEL);
      return counts.chunks === 4 && counts.embedded === 4;
    });
    const result = await h.search("giraffe river");
    expect(result.mode).toBe("hybrid");
    expect(result.notice).toBeNull();
    expect(result.hits[0]?.conversationId).toBe(giraffes);
    // One hit per conversation.
    expect(new Set(result.hits.map((hit) => hit.conversationId)).size).toBe(result.hits.length);
  });

  it("without the tenant's key keeps the keyword index, records why, and searches by words", async () => {
    // A key for the chat model's provider and none for the embedding model's.
    const h = await harness({
      modelKeys: async (_tenantId, provider) => (provider === "fake" ? "chat-key" : undefined),
    });
    await h.start();
    const model = "openai/text-embedding-3-small";
    await h.useModel(model);
    const giraffes = await h.chat("the giraffe migration crosses the river at dawn");

    const settings = await eventually("the refusal recorded", async () => {
      const current = await readSearchSettings(h.ctx.db);
      return current.lastError !== null && current;
    });
    expect(settings.lastError).toMatch(/no model key for provider "openai"/);
    expect(await indexCounts(h.ctx.db, model)).toEqual({ chunks: 2, embedded: 0 });

    const result = await h.search("giraffe");
    expect(result.mode).toBe("keyword");
    expect(result.notice).toMatch(/no model key/);
    expect(result.hits.map((hit) => hit.conversationId)).toEqual([giraffes]);
  });

  it("never indexes a message a guardrail blocked, nor its refusal", async () => {
    const h = await harness();
    await h.useModel(MODEL);
    const conversationId = await h.stored("forbidden giraffe secrets");
    await h.ctx.db.query(
      "update messages set blocked_by = '{no-secrets}' where conversation_id = $1",
      [conversationId],
    );
    await h.start();
    await h.spawn("index-conversation", { conversationId }, "index:blocked");

    // The watermark passes both messages and no chunk is written for either.
    await eventually("the watermark past the blocked messages", async () => {
      const { rows } = await h.ctx.db.query<{ indexed_seq: number }>(
        "select indexed_seq from search_progress where conversation_id = $1",
        [conversationId],
      );
      return rows[0]?.indexed_seq === 2;
    });
    expect(await indexCounts(h.ctx.db, MODEL)).toEqual({ chunks: 0, embedded: 0 });
  });

  it("a model change backfills every conversation a page at a time; a superseded backfill does nothing", async () => {
    const h = await harness();
    await h.stored("the giraffe migration crosses the river at dawn");
    await h.stored("quarterly invoice totals for the accounting team");
    // Past one backfill page (50), so the backfill must hand over to a second task to reach them all.
    for (let i = 0; i < 50; i++)
      await insertConversation(h.ctx.db, { model: "fake/fake-1", system: "", integrationId: null });
    const { settings } = await h.useModel(MODEL);
    await h.start();

    const stale = await h.spawn(
      "index-backfill",
      { generation: settings.generation - 1, after: null },
      "backfill:stale",
    );
    await eventually("the stale backfill to finish", async () => {
      const task = await readTask(h.ctx.db, "index-backfill", stale);
      return task?.state === "completed";
    });
    expect(await indexCounts(h.ctx.db, MODEL)).toEqual({ chunks: 0, embedded: 0 });

    await h.spawn(
      "index-backfill",
      { generation: settings.generation, after: null },
      `backfill:${settings.generation}:start`,
    );
    // The first page hands over to a second; both finish, and together they reach every conversation.
    const pages = await eventually("both backfill pages to finish", async () => {
      const { rows } = await h.ctx.db.query<{ after: string | null; state: string }>(
        `select params->>'after' as after, state from absurd.t_index
          where task_name = 'index-backfill' and (params->>'generation')::int = $1 order by params->>'after' nulls first`,
        [settings.generation],
      );
      return rows.length === 2 && rows.every((row) => row.state === "completed") && rows;
    });
    const { rows: ids } = await h.ctx.db.query<{ conversation_id: string }>(
      "select id::text as conversation_id from conversations order by conversations.id limit 50",
    );
    expect(pages.map((page) => page.after)).toEqual([null, ids.at(-1)?.conversation_id]);
    expect(await indexCounts(h.ctx.db, MODEL)).toEqual({ chunks: 4, embedded: 4 });
  });
});
