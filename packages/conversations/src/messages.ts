// Messages: the body is a JSON object in S3 (deterministic key), the tenant's `messages` row is the index and the
// order. Persist-before-act (ARCHITECTURE.md#durability): write the object, then the fenced index row.
import { createHash } from "node:crypto";
import type { AgentMessage, ContentPart } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import { AgentMessageSchema } from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext, spawnInTx } from "@kerby/durable";
import {
  ConversationBusyError,
  ConversationNotFoundError,
  LeaseLostError,
  SeqConflictError,
} from "./errors.ts";
import { conversationChannel } from "./events.ts";
import { isBusy, listMessageRows } from "./repo.ts";

/**
 * The object key of a message: position and a prefix of the content hash. Identical content at a position is the
 * same key (a retry overwrites itself); different content is a different key, so a stale writer can never replace
 * the bytes an index row already points at.
 */
export function messageKey(conversationId: string, seq: number, sha256: string): string {
  return `conversations/${conversationId}/messages/${String(seq).padStart(8, "0")}-${sha256.slice(0, 16)}.json`;
}

async function putMessage(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  seq: number,
  message: AgentMessage,
): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const { blobId } = await blobs.put(ctx, {
    kind: "message",
    key: messageKey(conversationId, seq, sha256),
    body,
    mediaType: "application/json",
    conversationId,
  });
  return blobId;
}

const MAX_POST_ATTEMPTS = 5;

/**
 * Append a user message and enqueue the turn that answers it, in one transaction in the tenant's database. A turn
 * is unique per message (`turn:<conversation>:<seq>`), and one runs at a time per conversation.
 */
export async function postUserMessage(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  content: ContentPart[],
): Promise<{ seq: number }> {
  const message: AgentMessage = { role: "user", content };
  for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
    const { rows } = await ctx.db.query<{ next: number }>(
      "select coalesce(max(seq), 0) + 1 as next from messages where conversation_id = $1",
      [conversationId],
    );
    const predicted = rows[0]?.next ?? 1;
    // The object goes first: its key needs the seq, which the transaction below re-checks under a row lock.
    const blobId = await putMessage(ctx, blobs, conversationId, predicted, message);
    const result = await ctx.db.transaction(async (tx) => {
      const locked = await tx.query("select 1 from conversations where id = $1 for update", [
        conversationId,
      ]);
      if (locked.rowCount === 0)
        throw new ConversationNotFoundError(`conversation ${conversationId} not found`);
      if (await isBusy(tx, conversationId)) {
        throw new ConversationBusyError("a turn is already running for this conversation");
      }
      const next = await tx.query<{ next: number }>(
        "select coalesce(max(seq), 0) + 1 as next from messages where conversation_id = $1",
        [conversationId],
      );
      const seq = next.rows[0]?.next ?? 1;
      if (seq !== predicted) return undefined; // another writer got in between: retry with the new position
      await tx.query("update conversations set last_error = null where id = $1", [conversationId]);
      await tx.query(
        "insert into messages (conversation_id, seq, role, blob_id) values ($1, $2, 'user', $3)",
        [conversationId, seq, blobId],
      );
      // Streams listening to this conversation see the message at once, and in order with the worker's events.
      await tx.query("select pg_notify($1, $2)", [
        conversationChannel(conversationId),
        JSON.stringify({ persisted: seq }),
      ]);
      await spawnInTx(
        tx,
        "run-turn",
        { conversationId, seq },
        { idempotencyKey: `turn:${conversationId}:${seq}` },
      );
      return seq;
    });
    if (result !== undefined) return { seq: result };
  }
  throw new Error(
    `could not append to conversation ${conversationId}: too many concurrent writers`,
  );
}

export type PersistInput = {
  conversationId: string;
  /** Must be the conversation's next position. */
  seq: number;
  message: AgentMessage;
  /** The run writing it: the insert is refused unless this run is still the task's current attempt. */
  run: Pick<RunContext, "taskId" | "runId" | "queue">;
};

/**
 * Persist one message of a turn (the supervisor's `message_end` handling). Idempotent for the same content at the
 * same position; refused with `LeaseLostError` when the run's lease has lapsed and another worker took over, and with
 * `SeqConflictError` when the position holds different content or would leave a gap. Announces the row to
 * `conversationChannel` on commit.
 */
export async function persistMessage(
  ctx: TenantContext,
  blobs: Blobs,
  input: PersistInput,
): Promise<"inserted" | "exists"> {
  const { conversationId, seq, message, run } = input;
  const blobId = await putMessage(ctx, blobs, conversationId, seq, message);
  return ctx.db.transaction(async (tx) => {
    if (!(await holdsRun(tx, run)))
      throw new LeaseLostError(`run ${run.runId} no longer owns task ${run.taskId}`);
    const inserted = await tx.query(
      `insert into messages (conversation_id, seq, role, blob_id, run_id)
       select $1, $2, $3, $4, $5
        where $2 = (select coalesce(max(seq), 0) + 1 from messages where conversation_id = $1)
       on conflict (conversation_id, seq) do nothing`,
      [conversationId, seq, message.role, blobId, run.runId],
    );
    if (inserted.rowCount === 1) {
      await tx.query("select pg_notify($1, $2)", [
        conversationChannel(conversationId),
        JSON.stringify({ persisted: seq }),
      ]);
      return "inserted";
    }
    const existing = await tx.query<{ blob_id: string }>(
      "select blob_id from messages where conversation_id = $1 and seq = $2",
      [conversationId, seq],
    );
    const row = existing.rows[0];
    if (!row) throw new SeqConflictError(`message ${seq} of ${conversationId} would leave a gap`);
    if (row.blob_id !== blobId)
      throw new SeqConflictError(
        `message ${seq} of ${conversationId} already holds different content`,
      );
    return "exists";
  });
}

export type StoredMessage = {
  seq: number;
  message: AgentMessage;
  runId: string | null;
  createdAt: Date;
};

/** Messages after `afterSeq` with their bodies, oldest first. Bodies are fetched concurrently and validated. */
export async function readMessages(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  afterSeq = 0,
): Promise<StoredMessage[]> {
  const rows = await listMessageRows(ctx.db, conversationId, afterSeq);
  const out: StoredMessage[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i];
      if (!row) continue;
      const { body } = await blobs.get(ctx, row.blobId);
      const message = AgentMessageSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      out[i] = { seq: row.seq, message, runId: row.runId, createdAt: row.createdAt };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker));
  return out;
}
