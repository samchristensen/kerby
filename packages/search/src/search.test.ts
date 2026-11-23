import { insertConversation, tenantMigrationDirs } from "@kerby/conversations";
import { createTestTenant, type TestTenant } from "@kerby/conversations/testing";
import { createTenantDb, migrate } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { describe, expect, it } from "vitest";
import {
  chunksToEmbed,
  chunkText,
  conversationIdsAfter,
  indexCounts,
  indexedSeq,
  readHits,
  readSearchSettings,
  searchChunks,
  searchMigrationsDir,
  setEmbeddingModel,
  setIndexError,
  writeChunks,
  writeEmbeddings,
} from "./index.ts";

type Said = { role: "user" | "assistant"; text: string };

async function conversation(
  tenant: TestTenant,
  externalUserId?: string,
  integrationId: string | null = null,
): Promise<string> {
  return (
    await insertConversation(tenant.db, { model: "m", system: "", externalUserId, integrationId })
  ).id;
}

/** Append message rows (their bodies are not needed here) and return their seqs. */
async function addMessages(tenant: TestTenant, conversationId: string, said: Said[]) {
  const { rows } = await tenant.db.query<{ last: number }>(
    "select coalesce(max(seq), 0)::int as last from messages where conversation_id = $1",
    [conversationId],
  );
  const first = (rows[0]?.last ?? 0) + 1;
  for (const [i, message] of said.entries()) {
    const blob = await tenant.db.query<{ id: string }>(
      "insert into blobs (object_key, kind, media_type, size, sha256) values ($1, 'message', 'application/json', 1, 'x') returning id",
      [`t/${tenant.tenantId}/${crypto.randomUUID()}`],
    );
    await tenant.db.query(
      "insert into messages (conversation_id, seq, role, blob_id) values ($1, $2, $3, $4)",
      [conversationId, first + i, message.role, blob.rows[0]?.id],
    );
  }
  return said.map((message, i) => ({ ...message, seq: first + i }));
}

/** Add the messages and index them, as the index task would. */
async function indexed(tenant: TestTenant, conversationId: string, said: Said[]): Promise<void> {
  const from = await indexedSeq(tenant.db, conversationId);
  const messages = await addMessages(tenant, conversationId, said);
  const written = await writeChunks(tenant.db, conversationId, {
    from,
    through: messages.at(-1)?.seq ?? from,
    messages: messages.map((m) => ({
      seq: m.seq,
      role: m.role,
      createdAt: new Date(),
      chunks: chunkText(m.text),
    })),
  });
  expect(written).toBe(true);
}

const embed = (
  tenant: TestTenant,
  conversationId: string,
  model: string,
  vector: number[],
  seq = 1,
) => writeEmbeddings(tenant.db, conversationId, model, [{ seq, part: 0, vector }]);

describe("writeChunks", () => {
  it("writes a batch only while the watermark is where the writer read it", async () => {
    await using tenant = await createTestTenant();
    const id = await conversation(tenant);
    const [first, second] = await addMessages(tenant, id, [
      { role: "user", text: "price the acme renewal" },
      { role: "assistant", text: "the renewal is 40k" },
    ]);
    if (!first || !second) throw new Error("no messages");
    const batch = (text: string) => ({
      from: 0,
      through: 2,
      messages: [{ seq: first.seq, role: first.role, createdAt: new Date(), chunks: [text] }],
    });
    // Two writers read watermark 0; the first to commit wins, the second writes nothing.
    expect(await writeChunks(tenant.db, id, batch("one"))).toBe(true);
    expect(await writeChunks(tenant.db, id, batch("two"))).toBe(false);
    expect(await indexedSeq(tenant.db, id)).toBe(2);
    const { rows } = await tenant.db.query("select seq, part, text from search_chunks");
    expect(rows).toEqual([{ seq: 1, part: 0, text: "one" }]);

    // Concurrent writers with the same `from`: exactly one succeeds.
    await addMessages(tenant, id, [{ role: "user", text: "again" }]);
    const next = {
      from: 2,
      through: 3,
      messages: [{ seq: 3, role: "user" as const, createdAt: new Date(), chunks: ["again"] }],
    };
    const results = await Promise.all([
      writeChunks(tenant.db, id, next),
      writeChunks(tenant.db, id, next),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await indexCounts(tenant.db, null)).toEqual({ chunks: 2, embedded: 0 });
  });

  it("is refused for a gone conversation, and a deleted conversation takes its chunks along", async () => {
    await using tenant = await createTestTenant();
    const id = await conversation(tenant);
    await indexed(tenant, id, [{ role: "user", text: "quarterly numbers" }]);
    expect(await indexCounts(tenant.db, null)).toEqual({ chunks: 1, embedded: 0 });
    await tenant.db.query("delete from conversations where id = $1", [id]);
    expect(await indexCounts(tenant.db, null)).toEqual({ chunks: 0, embedded: 0 });
    expect(await indexedSeq(tenant.db, id)).toBe(0);
    expect(await writeChunks(tenant.db, id, { from: 0, through: 0, messages: [] })).toBe(false);
  });
});

describe("embeddings", () => {
  it("lists the chunks a model has not embedded, stores vectors, and refuses broken ones", async () => {
    await using tenant = await createTestTenant();
    const id = await conversation(tenant);
    await indexed(tenant, id, [
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
    ]);
    expect(await chunksToEmbed(tenant.db, id, "fake/a", 10)).toEqual([
      { seq: 1, part: 0, text: "first" },
      { seq: 2, part: 0, text: "second" },
    ]);
    await embed(tenant, id, "fake/a", [1, 0]);
    expect(await chunksToEmbed(tenant.db, id, "fake/a", 10)).toEqual([
      { seq: 2, part: 0, text: "second" },
    ]);
    expect(await chunksToEmbed(tenant.db, id, "fake/b", 1)).toEqual([
      { seq: 1, part: 0, text: "first" },
    ]);
    expect(await indexCounts(tenant.db, "fake/a")).toEqual({ chunks: 2, embedded: 1 });
    await expect(embed(tenant, id, "fake/a", [1, Number.NaN], 2)).rejects.toThrow(/finite/);
    await expect(embed(tenant, id, "fake/a", [], 2)).rejects.toThrow(/dimension/);
  });
});

describe("searchChunks", () => {
  it("finds a conversation by a stemmed word, only the end user's when asked, and nothing for stopwords", async () => {
    await using tenant = await createTestTenant();
    const alice = await conversation(tenant, "alice");
    const bob = await conversation(tenant, "bob");
    await indexed(tenant, alice, [{ role: "user", text: "We priced the renewals yesterday." }]);
    await indexed(tenant, bob, [{ role: "assistant", text: "Pricing the renewal is next." }]);
    await indexed(tenant, await conversation(tenant), [{ role: "user", text: "unrelated" }]);

    const hits = await searchChunks(tenant.db, { query: "renewal pricing", limit: 10 }, "tenant");
    expect(hits.map((h) => h.conversationId).sort()).toEqual([alice, bob].sort());
    expect(
      await searchChunks(
        tenant.db,
        { query: "renewing", limit: 10, externalUserId: "alice" },
        "tenant",
      ),
    ).toEqual([{ conversationId: alice, seq: 1, part: 0, score: expect.any(Number) }]);
    expect(await searchChunks(tenant.db, { query: "the and of", limit: 10 }, "tenant")).toEqual([]);
    expect(await searchChunks(tenant.db, { query: "renewal", limit: 1 }, "tenant")).toHaveLength(1);
  });

  it("finds only the conversations its visibility sees: one integration's, or the tenant's", async () => {
    await using tenant = await createTestTenant();
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    const ours = await conversation(tenant, undefined, mine);
    const others = await conversation(tenant, undefined, theirs);
    const fromConsole = await conversation(tenant);
    for (const id of [ours, others, fromConsole])
      await indexed(tenant, id, [{ role: "user", text: "the acme renewal" }]);
    const found = async (visibility: "tenant" | { integrationId: string }) =>
      (await searchChunks(tenant.db, { query: "renewal", limit: 10 }, visibility))
        .map((hit) => hit.conversationId)
        .sort();

    expect(await found({ integrationId: mine })).toEqual([ours]);
    expect(await found("tenant")).toEqual([ours, others, fromConsole].sort());
    // Reading hits by reference applies it again: refs from a wider search show only what this caller sees.
    const all = await searchChunks(tenant.db, { query: "renewal", limit: 10 }, "tenant");
    const read = await readHits(tenant.db, "renewal", all, { integrationId: theirs });
    expect(read.map((hit) => hit.conversationId)).toEqual([others]);
  });

  it("returns the best chunk of each conversation once", async () => {
    await using tenant = await createTestTenant();
    const id = await conversation(tenant);
    await indexed(tenant, id, [
      { role: "user", text: "the invoice" },
      { role: "assistant", text: "the invoice, the invoice, and the other invoice" },
    ]);
    const hits = await searchChunks(tenant.db, { query: "invoice", limit: 10 }, "tenant");
    expect(hits).toEqual([{ conversationId: id, seq: 2, part: 0, score: expect.any(Number) }]);
  });

  it("fuses keyword and semantic ranks, among chunks of the query's model and dimension only", async () => {
    await using tenant = await createTestTenant();
    const model = "fake/small";
    const close = await conversation(tenant);
    const wordy = await conversation(tenant);
    const meaningOnly = await conversation(tenant);
    const otherModel = await conversation(tenant);
    const otherDims = await conversation(tenant);
    await indexed(tenant, close, [{ role: "user", text: "the acme renewal price" }]);
    await indexed(tenant, wordy, [{ role: "user", text: "renewal renewal renewal of nothing" }]);
    await indexed(tenant, meaningOnly, [
      { role: "user", text: "what the customer pays next year" },
    ]);
    await indexed(tenant, otherModel, [{ role: "user", text: "a different index" }]);
    await indexed(tenant, otherDims, [{ role: "user", text: "longer vectors" }]);
    await embed(tenant, close, model, [1, 0, 0]);
    await embed(tenant, meaningOnly, model, [0.9, 0.3, 0]);
    await embed(tenant, wordy, model, [0, 1, 0]);
    await embed(tenant, otherModel, "fake/other", [1, 0, 0]);
    await embed(tenant, otherDims, model, [1, 0, 0, 0]);

    // Keyword alone ranks the chunk that repeats the word first.
    const keyword = await searchChunks(tenant.db, { query: "renewal", limit: 10 }, "tenant");
    expect(keyword.map((h) => h.conversationId)).toEqual([wordy, close]);

    const embedding = { model, vector: [1, 0, 0] };
    const hybrid = await searchChunks(
      tenant.db,
      { query: "renewal", limit: 10, embedding },
      "tenant",
    );
    // close: keyword 2nd and semantic 1st; wordy: keyword 1st and semantic 3rd; meaningOnly: semantic 2nd only.
    expect(hybrid.map((h) => h.conversationId)).toEqual([close, wordy, meaningOnly]);
    expect(hybrid[0]?.score).toBeCloseTo(1 / 62 + 1 / 61);

    // A query of stopwords still finds by meaning.
    const semantic = await searchChunks(
      tenant.db,
      { query: "the", limit: 10, embedding },
      "tenant",
    );
    expect(semantic.map((h) => h.conversationId)).toEqual([close, meaningOnly, wordy]);
  });
});

describe("readHits", () => {
  it("reads hits in the refs' order with a plain snippet, and drops a hit whose conversation is gone", async () => {
    await using tenant = await createTestTenant();
    const first = await conversation(tenant);
    const second = await conversation(tenant);
    await tenant.db.query("update conversations set title = 'Acme renewal' where id = $1", [first]);
    const long = `${"Filler words about many things. ".repeat(30)}The renewal price for Acme is forty thousand. ${"More filler afterwards. ".repeat(30)}`;
    await indexed(tenant, first, [
      { role: "user", text: "hello" },
      { role: "assistant", text: long },
    ]);
    await indexed(tenant, second, [{ role: "user", text: "renewal dates" }]);
    const refs = await searchChunks(tenant.db, { query: "renewal", limit: 10 }, "tenant");
    const reversed = [...refs].reverse();

    const hits = await readHits(tenant.db, "renewal", reversed, "tenant");
    expect(hits.map((h) => h.conversationId)).toEqual(reversed.map((r) => r.conversationId));
    const acme = hits.find((h) => h.conversationId === first);
    expect(acme).toMatchObject({ role: "assistant", title: "Acme renewal", seq: 2 });
    expect(acme?.snippet).toContain("The renewal price for Acme");
    expect(acme?.snippet).not.toContain("<b>");
    expect(acme?.snippet.length).toBeLessThan(long.length / 2);
    expect(acme?.createdAt).toBeInstanceOf(Date);

    await tenant.db.query("delete from conversations where id = $1", [second]);
    expect(
      (await readHits(tenant.db, "renewal", refs, "tenant")).map((h) => h.conversationId),
    ).toEqual([first]);
    expect(await readHits(tenant.db, "renewal", [], "tenant")).toEqual([]);
  });
});

describe("settings", () => {
  it("bumps the generation only when the model changes, and clears the error then", async () => {
    await using tenant = await createTestTenant();
    expect(await readSearchSettings(tenant.db)).toMatchObject({
      embeddingModel: null,
      generation: 0,
      lastError: null,
    });
    const set = (model: string | null) =>
      tenant.db.transaction((tx) => setEmbeddingModel(tx, model));
    expect(await set("openai/a")).toMatchObject({
      changed: true,
      settings: { embeddingModel: "openai/a", generation: 1 },
    });
    await setIndexError(tenant.db, "openai/a", "invalid api key");
    expect(await set("openai/a")).toMatchObject({
      changed: false,
      settings: { generation: 1, lastError: "invalid api key" },
    });
    expect(await set("openai/b")).toMatchObject({
      changed: true,
      settings: { embeddingModel: "openai/b", generation: 2, lastError: null },
    });
    // A task still embedding with the old model cannot report on the new one.
    await setIndexError(tenant.db, "openai/a", "late");
    expect((await readSearchSettings(tenant.db)).lastError).toBeNull();
    expect(await set(null)).toMatchObject({
      changed: true,
      settings: { embeddingModel: null, generation: 3 },
    });
  });
});

describe("backfill", () => {
  it("pages conversations by id", async () => {
    await using tenant = await createTestTenant();
    const ids = await Promise.all([1, 2, 3].map(() => conversation(tenant)));
    const sorted = [...ids].sort();
    expect(await conversationIdsAfter(tenant.db, null, 2)).toEqual(sorted.slice(0, 2));
    expect(await conversationIdsAfter(tenant.db, sorted[1] ?? null, 2)).toEqual(sorted.slice(2));
  });

  it("is spawned by the migration for a database that has conversations, not for an empty one", async () => {
    await using empty = await createTestTenant();
    const tasks = (db: TestTenant["db"]) =>
      db.query("select task_name, params, idempotency_key from absurd.t_index");
    expect((await tasks(empty.db)).rows).toEqual([]);

    // An existing tenant: everything but the search index, with a conversation, then migrated.
    const before = await createMigratedDatabase(
      tenantMigrationDirs.filter((dir) => dir !== searchMigrationsDir),
    );
    const db = createTenantDb(before.url, { max: 1 });
    try {
      await db.query("insert into conversations (model) values ('m')");
      expect(await migrate(db, tenantMigrationDirs)).toEqual(["search/0001_search.sql"]);
      expect((await tasks(db)).rows).toEqual([
        {
          task_name: "index-backfill",
          params: { generation: 0, after: null },
          idempotency_key: "backfill:0:start",
        },
      ]);
    } finally {
      await db.close();
      await before.drop();
    }
  });
});
