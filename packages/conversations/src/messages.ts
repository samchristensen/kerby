// Messages: the body is a JSON object in S3, the tenant's `messages` row is the index and the order. Persist-before-act
// (ARCHITECTURE.md#durability): write the object, then the fenced index row.
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage, ContentPart } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import { AgentMessageSchema } from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext, spawnInTx } from "@kerby/durable";
import { announceEvents, recordEvent } from "@kerby/events";
import { errorFields, log, withTenant } from "@kerby/observability";
import { StorageQuotaExceededError, storedBytes } from "@kerby/prompts";
import {
  ConversationBusyError,
  ConversationFullError,
  ConversationNotFoundError,
  LeaseLostError,
  SeqConflictError,
} from "./errors.ts";
import { conversationChannel } from "./events.ts";
import {
  isBusy,
  listMessageRows,
  listMessageRowsNewestFirst,
  type MessageRowRecord,
  titleFrom,
} from "./repo.ts";

/**
 * The object key of a message: position and a prefix of the content hash. Identical content at a position is the
 * same key (a retry overwrites itself); different content is a different key, so a stale writer can never replace
 * the bytes an index row already points at. A `unique` suffix makes the key this writer's alone: only then may it
 * delete the blob again (a user post that fails after storing its body), because a key is one blob row.
 */
function messageKey(conversationId: string, seq: number, sha256: string, unique?: string): string {
  const suffix = unique === undefined ? "" : `-${unique}`;
  return `conversations/${conversationId}/messages/${String(seq).padStart(8, "0")}-${sha256.slice(0, 16)}${suffix}.json`;
}

const encodeMessage = (message: AgentMessage): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(message));

async function putMessage(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  seq: number,
  body: Uint8Array,
  unique?: string,
): Promise<string> {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const { blobId } = await blobs.put(ctx, {
    kind: "message",
    key: messageKey(conversationId, seq, sha256, unique),
    body,
    mediaType: "application/json",
    conversationId,
  });
  return blobId;
}

/**
 * Take back a user post's blob after the post failed, so a refused post leaves no row counting toward the quota and no
 * object. A failure here is logged and not raised: the caller is about to surface the refusal, which matters more.
 */
async function discardBlob(ctx: TenantContext, blobs: Blobs, blobId: string): Promise<void> {
  try {
    await blobs.delete(ctx, blobId);
  } catch (error) {
    withTenant(ctx.tenantId, () =>
      log("warn", "could not remove the blob of a refused post", errorFields(error)),
    );
  }
}

function refuseOverQuota(stored: number, adding: number, quota: number): void {
  if (stored + adding <= quota) return;
  throw new StorageQuotaExceededError(
    `the tenant stores ${stored} bytes and this message adds ${adding}, past its storage quota of ${quota} bytes; ask the operator to raise limits.storageBytes`,
  );
}

const MAX_POST_ATTEMPTS = 5;

/**
 * What one conversation may hold. Reads are paged and a turn reads its history within a byte budget, so these bound
 * storage and the index rows a rehydrate scans, not memory; a tenant that reaches them starts a new conversation.
 */
const MAX_CONVERSATION_MESSAGES = 2000;
export const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;

/**
 * Append a user message and enqueue the turn that answers it, in one transaction in the tenant's database. A turn
 * is unique per message (`turn:<conversation>:<seq>`), and one runs at a time per conversation. Refused with
 * `StorageQuotaExceededError` when the tenant's stored bytes plus this message would pass `limits.storageBytes`; the
 * turn's own answer is not counted against it (an admitted turn finishes).
 */
export async function postUserMessage(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  content: ContentPart[],
  limits: { storageBytes: number },
): Promise<{ seq: number }> {
  const message: AgentMessage = { role: "user", content };
  const body = encodeMessage(message);
  // Refuse before storing anything: a refused post must not leave an object in S3 and a row in the index.
  const { rows: size } = await ctx.db.query<{ messages: number; bytes: string }>(
    `select count(*)::int as messages, coalesce(sum(b.size), 0)::text as bytes
       from messages m join blobs b on b.id = m.blob_id where m.conversation_id = $1`,
    [conversationId],
  );
  if (
    (size[0]?.messages ?? 0) >= MAX_CONVERSATION_MESSAGES ||
    Number(size[0]?.bytes ?? 0) >= MAX_CONVERSATION_BYTES
  ) {
    throw new ConversationFullError(
      `a conversation holds at most ${MAX_CONVERSATION_MESSAGES} messages and ${MAX_CONVERSATION_BYTES / 1024 / 1024} MiB: start a new one`,
    );
  }
  refuseOverQuota(await storedBytes(ctx.db), body.byteLength, limits.storageBytes);
  if (await isBusy(ctx.db, conversationId)) {
    throw new ConversationBusyError("a turn is already running for this conversation");
  }
  for (let attempt = 0; attempt < MAX_POST_ATTEMPTS; attempt++) {
    const { rows } = await ctx.db.query<{ next: number }>(
      "select coalesce(max(seq), 0) + 1 as next from messages where conversation_id = $1",
      [conversationId],
    );
    const predicted = rows[0]?.next ?? 1;
    // The object goes first: its key needs the seq, which the transaction below re-checks under a row lock. The key is
    // unique to this attempt, so the blob can be taken back if the post does not commit.
    const blobId = await putMessage(ctx, blobs, conversationId, predicted, body, randomUUID());
    const result = await ctx.db
      .transaction(async (tx) => {
        const locked = await tx.query<{ integration_id: string | null }>(
          "select integration_id from conversations where id = $1 for update",
          [conversationId],
        );
        const conversation = locked.rows[0];
        if (!conversation)
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
        // Again under the lock, with what other conversations stored meanwhile; the object just written is left out.
        refuseOverQuota(await storedBytes(tx, blobId), body.byteLength, limits.storageBytes);
        // The title is the opening of the conversation's first message; later messages leave it alone.
        const opening = content.find((part) => part.type === "text");
        await tx.query(
          "update conversations set last_error = null, updated_at = now(), title = coalesce(title, $2) where id = $1",
          [conversationId, opening ? titleFrom(opening.text) : null],
        );
        await tx.query(
          "insert into messages (conversation_id, seq, role, blob_id) values ($1, $2, 'user', $3)",
          [conversationId, seq, blobId],
        );
        await recordEvent(tx, {
          type: "message.created",
          integrationId: conversation.integration_id,
          dedupeKey: `message:${conversationId}:${seq}`,
          data: { conversationId, seq, role: "user" },
        });
        await spawnInTx(
          tx,
          "run-turn",
          { conversationId, seq },
          { idempotencyKey: `turn:${conversationId}:${seq}` },
        );
        return seq;
      })
      .catch(async (error: unknown) => {
        // Refused or failed after the put (a quota or busy race, a missing conversation): leave neither row nor object.
        await discardBlob(ctx, blobs, blobId);
        throw error;
      });
    if (result !== undefined) {
      // Streams listening to this conversation see the message at once, and in order with the worker's events.
      await announcePersisted(ctx, conversationId, result);
      return { seq: result };
    }
    await discardBlob(ctx, blobs, blobId); // another writer took the position: this object's key names the wrong one
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
  /** Guardrails that blocked the exchange this message belongs to (the refusal): it is kept out of later turns' history. */
  blockedBy?: readonly string[] | undefined;
  /** The run writing it: the insert is refused unless this run is still the task's current attempt. */
  run: Pick<RunContext, "taskId" | "runId" | "queue">;
};

/**
 * Persist one message of a turn (the supervisor's `message_end` handling). Idempotent for the same content at the
 * same position; refused with `LeaseLostError` when the run's lease has lapsed and another worker took over, and with
 * `SeqConflictError` when the position holds different content or would leave a gap. Announces the row to
 * `conversationChannel` once it has committed.
 */
export async function persistMessage(
  ctx: TenantContext,
  blobs: Blobs,
  input: PersistInput,
): Promise<"inserted" | "exists"> {
  const { conversationId, seq, message, run } = input;
  const blobId = await putMessage(ctx, blobs, conversationId, seq, encodeMessage(message));
  const outcome = await ctx.db.transaction(async (tx) => {
    if (!(await holdsRun(tx, run)))
      throw new LeaseLostError(`run ${run.runId} no longer owns task ${run.taskId}`);
    const inserted = await tx.query(
      `insert into messages (conversation_id, seq, role, blob_id, run_id, blocked_by)
       select $1, $2, $3, $4, $5, $6
        where $2 = (select coalesce(max(seq), 0) + 1 from messages where conversation_id = $1)
       on conflict (conversation_id, seq) do nothing`,
      [conversationId, seq, message.role, blobId, run.runId, input.blockedBy ?? null],
    );
    if (inserted.rowCount === 1) {
      const updated = await tx.query<{ integration_id: string | null }>(
        "update conversations set updated_at = now() where id = $1 returning integration_id",
        [conversationId],
      );
      await recordEvent(tx, {
        type: "message.created",
        integrationId: updated.rows[0]?.integration_id ?? null,
        dedupeKey: `message:${conversationId}:${seq}`,
        data: { conversationId, seq, role: message.role },
      });
      return "inserted" as const;
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
    return "exists" as const;
  });
  if (outcome === "inserted") await announcePersisted(ctx, conversationId, seq);
  return outcome;
}

/**
 * Tell the conversation's streams that `seq` is stored, and the event log's long-polls that its `message.created` is.
 * Sent after the commit, never inside the writing transaction:
 * Postgres commits every transaction that sent a NOTIFY under one lock shared by the whole cluster, held through the
 * commit's WAL flush, so a NOTIFY inside a write makes every tenant's writes flush one at a time (measured on Postgres 18,
 * 32 clients: 9.2k writes/s with the NOTIFY inside, 20k with it after the commit). A NOTIFY on its own has nothing to
 * flush. Best effort: a stream that misses it reads the index at its next poll.
 */
async function announcePersisted(
  ctx: TenantContext,
  conversationId: string,
  seq: number,
): Promise<void> {
  try {
    await ctx.db.query("select pg_notify($1, $2)", [
      conversationChannel(conversationId),
      JSON.stringify({ persisted: seq }),
    ]);
  } catch (error) {
    withTenant(ctx.tenantId, () =>
      log("warn", "could not announce a stored message; streams find it at their next poll", {
        conversationId,
        seq,
        ...errorFields(error),
      }),
    );
  }
  await announceEvents(ctx.db);
}

/**
 * Flag a user message as blocked by `names`, so no later turn rehydrates it. Fenced like `persistMessage`: refused with
 * `LeaseLostError` once the run's lease has lapsed. Idempotent.
 */
export async function blockMessage(
  ctx: TenantContext,
  input: Pick<PersistInput, "conversationId" | "seq" | "run"> & { blockedBy: readonly string[] },
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    if (!(await holdsRun(tx, input.run)))
      throw new LeaseLostError(`run ${input.run.runId} no longer owns task ${input.run.taskId}`);
    await tx.query(
      "update messages set blocked_by = $3 where conversation_id = $1 and seq = $2 and role = 'user'",
      [input.conversationId, input.seq, input.blockedBy],
    );
  });
}

export type StoredMessage = {
  seq: number;
  message: AgentMessage;
  runId: string | null;
  createdAt: Date;
  /** Guardrails that blocked the message (or the exchange it refuses); null when it was not blocked. */
  blockedBy: string[] | null;
};

/** Bodies for index rows, eight S3 gets at a time, validated, in the rows' order. */
async function withBodies(
  ctx: TenantContext,
  blobs: Blobs,
  rows: readonly MessageRowRecord[],
): Promise<StoredMessage[]> {
  const out: StoredMessage[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i];
      if (!row) continue;
      const { body } = await blobs.get(ctx, row.blobId);
      const message = AgentMessageSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      out[i] = {
        seq: row.seq,
        message,
        runId: row.runId,
        createdAt: row.createdAt,
        blockedBy: row.blockedBy,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, rows.length) }, worker));
  return out;
}

/** The most messages one page may hold (`GET /v1/conversations/:id?limit=`). */
export const MAX_PAGE_MESSAGES = 500;

export type MessagePage = {
  messages: StoredMessage[];
  /** The `after` of the next page; null when this page reaches the newest message. */
  nextAfter: number | null;
};

/** Up to `limit` messages after seq `after`, oldest first, with their bodies. */
export async function readMessages(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  page: { after: number; limit: number },
): Promise<MessagePage> {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE_MESSAGES)
    throw new RangeError(`a page holds 1 to ${MAX_PAGE_MESSAGES} messages, not ${page.limit}`);
  // One row more than asked says whether another page follows.
  const rows = await listMessageRows(ctx.db, conversationId, {
    after: page.after,
    limit: page.limit + 1,
  });
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  return {
    messages: await withBodies(ctx, blobs, kept),
    nextAfter: more ? (kept.at(-1)?.seq ?? null) : null,
  };
}

export type History = {
  /** The newest whole turns that fit the budget, oldest first. */
  messages: StoredMessage[];
  /** The conversation's last seq (0 when empty): the next message is this plus one. */
  lastSeq: number;
  bytes: number;
  /** Older messages left out to stay within the budget. */
  dropped: { messages: number; bytes: number };
};

/**
 * A turn's history: the newest messages whose bodies fit `budgetBytes` (sizes from the blob index, so nothing over
 * the budget is fetched). It is cut only before a user message, so it starts a turn and never separates a tool call
 * from its result. The newest turn is always whole, even past the budget: it is the one being answered.
 */
export async function readHistory(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  budgetBytes: number,
): Promise<History> {
  const all = await listMessageRowsNewestFirst(ctx.db, conversationId);
  // A blocked message and its refusal keep their positions in the index but are never shown to the model again.
  const rows = all.filter((row) => row.blockedBy === null);
  let keep = 0;
  let bytes = 0;
  let pending = 0;
  for (const [i, row] of rows.entries()) {
    pending += row.size;
    if (row.role !== "user") continue;
    // rows[keep..i] is one whole turn, newest first.
    if (keep > 0 && bytes + pending > budgetBytes) break;
    bytes += pending;
    pending = 0;
    keep = i + 1;
  }
  if (keep === 0) {
    // No user message to cut before (not a conversation the api writes): keep it all.
    keep = rows.length;
    bytes = pending;
  }
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  return {
    messages: await withBodies(ctx, blobs, rows.slice(0, keep).reverse()),
    lastSeq: all[0]?.seq ?? 0,
    bytes,
    dropped: { messages: rows.length - keep, bytes: total - bytes },
  };
}
