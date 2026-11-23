// Building the index (ADR 0019): chunks are written a batch at a time behind a per-conversation watermark, then
// embedded. No connection is held across a provider call: the caller reads, calls out, then writes in one short
// transaction that checks nothing moved meanwhile.
import type { TenantDb, TenantQueryable } from "@kerby/db";

/** How far `conversationId` is chunked: its messages up to this seq are in the index (0 when none are). */
export async function indexedSeq(db: TenantQueryable, conversationId: string): Promise<number> {
  const { rows } = await db.query<{ indexed_seq: number }>(
    "select indexed_seq from search_progress where conversation_id = $1",
    [conversationId],
  );
  return rows[0]?.indexed_seq ?? 0;
}

export type MessageChunks = {
  seq: number;
  role: "user" | "assistant";
  /** The message's time, shown with a hit. */
  createdAt: Date;
  chunks: string[];
};

/**
 * Store the chunks of the messages after seq `from` up to `through` (messages with nothing to index are simply absent)
 * and move the watermark to `through`, in one transaction, only if the watermark is still `from`. False, with nothing
 * written, when another writer moved it first (a duplicate or concurrent task) or the conversation is gone.
 */
export async function writeChunks(
  db: TenantDb,
  conversationId: string,
  batch: { from: number; through: number; messages: MessageChunks[] },
): Promise<boolean> {
  const { from, through, messages } = batch;
  if (!Number.isInteger(from) || !Number.isInteger(through) || from < 0 || through < from)
    throw new RangeError(`a batch runs from a seq to one no lower, not ${from} to ${through}`);
  const seqs: number[] = [];
  const parts: number[] = [];
  const roles: string[] = [];
  const texts: string[] = [];
  const times: string[] = [];
  for (const message of messages) {
    if (message.seq <= from || message.seq > through)
      throw new RangeError(`message ${message.seq} is outside the batch ${from} to ${through}`);
    for (const [part, text] of message.chunks.entries()) {
      seqs.push(message.seq);
      parts.push(part);
      roles.push(message.role);
      texts.push(text);
      times.push(message.createdAt.toISOString());
    }
  }
  return db.transaction(async (tx) => {
    // The progress row is the lock: made on the first batch (unless the conversation was deleted), then held.
    await tx.query(
      `insert into search_progress (conversation_id, indexed_seq)
       select $1, 0 where exists (select 1 from conversations where id = $1)
       on conflict (conversation_id) do nothing`,
      [conversationId],
    );
    const { rows } = await tx.query<{ indexed_seq: number }>(
      "select indexed_seq from search_progress where conversation_id = $1 for update",
      [conversationId],
    );
    if (rows[0]?.indexed_seq !== from) return false;
    if (seqs.length > 0) {
      await tx.query(
        `insert into search_chunks (conversation_id, seq, part, role, text, created_at)
         select $1, * from unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::timestamptz[])
         on conflict (conversation_id, seq, part) do nothing`,
        [conversationId, seqs, parts, roles, texts, times],
      );
    }
    await tx.query(
      "update search_progress set indexed_seq = $2, updated_at = now() where conversation_id = $1",
      [conversationId, through],
    );
    return true;
  });
}

export type PendingChunk = { seq: number; part: number; text: string };

/** Up to `limit` of the conversation's chunks with no embedding by `model`, in order. */
export async function chunksToEmbed(
  db: TenantQueryable,
  conversationId: string,
  model: string,
  limit: number,
): Promise<PendingChunk[]> {
  const { rows } = await db.query<PendingChunk>(
    `select seq, part, text from search_chunks
      where conversation_id = $1 and embedding_model is distinct from $2
      order by seq, part limit $3`,
    [conversationId, model, limit],
  );
  return rows;
}

/** `[1,2,3]`, pgvector's text form, after checking every element is a finite number (halfvec refuses the rest). */
export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length === 0) throw new RangeError("an embedding has at least one dimension");
  for (const value of vector) {
    if (!Number.isFinite(value))
      throw new RangeError(
        `an embedding holds only finite numbers, not ${value}: the provider returned a broken vector`,
      );
  }
  return `[${vector.join(",")}]`;
}

/** Store embeddings by `model` for the conversation's chunks; a chunk deleted meanwhile is skipped. */
export async function writeEmbeddings(
  db: TenantQueryable,
  conversationId: string,
  model: string,
  vectors: { seq: number; part: number; vector: number[] }[],
): Promise<void> {
  if (vectors.length === 0) return;
  const literals = vectors.map((v) => vectorLiteral(v.vector));
  await db.query(
    `update search_chunks c set embedding = v.embedding::halfvec, embedding_model = $2
       from unnest($3::int[], $4::int[], $5::text[]) as v(seq, part, embedding)
      where c.conversation_id = $1 and c.seq = v.seq and c.part = v.part`,
    [conversationId, model, vectors.map((v) => v.seq), vectors.map((v) => v.part), literals],
  );
}

/** Up to `limit` conversation ids after `after` (null: from the first), in id order: a backfill's page. */
export async function conversationIdsAfter(
  db: TenantQueryable,
  after: string | null,
  limit: number,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "select id from conversations where $1::uuid is null or id > $1::uuid order by id limit $2",
    [after, limit],
  );
  return rows.map((row) => row.id);
}
