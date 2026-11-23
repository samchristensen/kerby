import type { Guardrail } from "@kerby/contracts";
import type { TenantQueryable } from "@kerby/db";
import { InvalidCursorError } from "./errors.ts";

export type ConversationRecord = {
  id: string;
  externalUserId: string | null;
  model: string;
  system: string;
  title: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  guardrails: Guardrail[];
};

type ConversationRow = {
  id: string;
  external_user_id: string | null;
  model: string;
  system: string;
  title: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  guardrails: Guardrail[];
};

const COLUMNS =
  "id, external_user_id, model, system, title, last_error, created_at, updated_at, guardrails";

const fromRow = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  externalUserId: row.external_user_id,
  model: row.model,
  system: row.system,
  title: row.title,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  guardrails: row.guardrails,
});

/** A conversation in a list: no system prompt (it may be 100 000 characters), with how many messages it holds. */
export type ConversationSummaryRecord = Omit<
  ConversationRecord,
  "system" | "lastError" | "guardrails"
> & {
  messageCount: number;
};

/** How many characters a title keeps: the opening of the first message, enough to recognise the conversation by. */
const TITLE_CHARACTERS = 80;

/** A title from a message's text: whitespace and control characters (Postgres refuses NUL) collapsed, cut at 80. */
export function titleFrom(text: string): string | null {
  const flat = text.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (flat === "") return null;
  const characters = Array.from(flat);
  return characters.length <= TITLE_CHARACTERS
    ? flat
    : `${characters.slice(0, TITLE_CHARACTERS).join("").trimEnd()}…`;
}

const CURSOR =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * One page of a tenant's conversations, most recently active first, however each began (API call or console). A
 * page's `nextCursor` goes back in as `cursor` for the page after it; null on the last page. `externalUserId` keeps
 * one end user's conversations. A cursor holds the last row's `updated_at` to the microsecond, so a conversation that
 * moves while paging is seen at most once more, never skipped.
 */
export async function listConversations(
  db: TenantQueryable,
  page: { limit: number; cursor?: string | undefined; externalUserId?: string | undefined },
): Promise<{ conversations: ConversationSummaryRecord[]; nextCursor: string | null }> {
  let after: RegExpExecArray | null = null;
  if (page.cursor !== undefined) {
    after = CURSOR.exec(page.cursor);
    if (!after) throw new InvalidCursorError("cursor is not one this API returned");
  }
  const { rows } = await db.query<
    Omit<ConversationRow, "system" | "last_error"> & { cursor_at: string; message_count: number }
  >(
    `select c.id, c.external_user_id, c.model, c.title, c.created_at, c.updated_at,
            to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
            (select count(*)::int from messages m where m.conversation_id = c.id) as message_count
       from conversations c
      where ($1::text is null or c.external_user_id = $1)
        and ($2::timestamptz is null or (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
      order by c.updated_at desc, c.id desc
      limit $4`,
    [page.externalUserId ?? null, after?.[1] ?? null, after?.[2] ?? null, page.limit + 1],
  );
  const rowsOfPage = rows.slice(0, page.limit);
  const last = rowsOfPage.at(-1);
  return {
    conversations: rowsOfPage.map((row) => ({
      id: row.id,
      externalUserId: row.external_user_id,
      model: row.model,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    })),
    nextCursor: rows.length > page.limit && last ? `${last.cursor_at}_${last.id}` : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A conversation id from a URL is only ever looked up as a uuid; anything else is simply not found. */
export const isConversationId = (value: string): boolean => UUID.test(value);

export async function insertConversation(
  db: TenantQueryable,
  input: {
    externalUserId?: string | undefined;
    model: string;
    system: string;
    guardrails?: Guardrail[] | undefined;
  },
): Promise<ConversationRecord> {
  const { rows } = await db.query<ConversationRow>(
    `insert into conversations (external_user_id, model, system, guardrails) values ($1, $2, $3, $4::jsonb) returning ${COLUMNS}`,
    [
      input.externalUserId ?? null,
      input.model,
      input.system,
      JSON.stringify(input.guardrails ?? []),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("conversation insert returned no row");
  return fromRow(row);
}

export async function findConversation(
  db: TenantQueryable,
  id: string,
): Promise<ConversationRecord | undefined> {
  if (!isConversationId(id)) return undefined;
  const { rows } = await db.query<ConversationRow>(
    `select ${COLUMNS} from conversations where id = $1`,
    [id],
  );
  return rows[0] ? fromRow(rows[0]) : undefined;
}

export type MessageRowRecord = {
  seq: number;
  role: "user" | "assistant" | "tool";
  blobId: string;
  runId: string | null;
  createdAt: Date;
  /** The guardrails that blocked it, or null. A blocked message is never part of a turn's history. */
  blockedBy: string[] | null;
};

type MessageRow = {
  seq: number;
  role: "user" | "assistant" | "tool";
  blob_id: string;
  run_id: string | null;
  created_at: Date;
  blocked_by: string[] | null;
};

const fromMessageRow = (row: MessageRow): MessageRowRecord => ({
  seq: row.seq,
  role: row.role,
  blobId: row.blob_id,
  runId: row.run_id,
  createdAt: row.created_at,
  blockedBy: row.blocked_by,
});

/** Up to `limit` index rows of a conversation after seq `after`, oldest first. Bodies live in S3: see `readMessages`. */
export async function listMessageRows(
  db: TenantQueryable,
  conversationId: string,
  page: { after: number; limit: number },
): Promise<MessageRowRecord[]> {
  const { rows } = await db.query<MessageRow>(
    "select seq, role, blob_id, run_id, created_at, blocked_by from messages where conversation_id = $1 and seq > $2 order by seq limit $3",
    [conversationId, page.after, page.limit],
  );
  return rows.map(fromMessageRow);
}

/** Every index row of a conversation with its body's size, newest first: what a history budget is cut from. */
export async function listMessageRowsNewestFirst(
  db: TenantQueryable,
  conversationId: string,
): Promise<(MessageRowRecord & { size: number })[]> {
  const { rows } = await db.query<MessageRow & { size: string }>(
    `select m.seq, m.role, m.blob_id, m.run_id, m.created_at, m.blocked_by, b.size::text as size
       from messages m join blobs b on b.id = m.blob_id
      where m.conversation_id = $1 order by m.seq desc`,
    [conversationId],
  );
  return rows.map((row) => ({ ...fromMessageRow(row), size: Number(row.size) }));
}

/** Is a turn for this conversation queued, running or sleeping? */
export async function isBusy(db: TenantQueryable, conversationId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "select 1 from absurd.t_turns where params->>'conversationId' = $1 and state in ('pending', 'running', 'sleeping') limit 1",
    [conversationId],
  );
  return rowCount > 0;
}

/** Record why the latest turn produced no answer (null clears it). */
export async function setLastError(
  db: TenantQueryable,
  conversationId: string,
  error: string | null,
): Promise<void> {
  await db.query("update conversations set last_error = $2 where id = $1", [conversationId, error]);
}

/**
 * Count one real execution of a tool call (call this inside the step that runs it). Returns the running count: 1 for a
 * call that ran once, more when a retry ran it again.
 */
export async function recordToolExecution(
  db: TenantQueryable,
  input: { conversationId: string; callId: string; name: string },
): Promise<number> {
  const { rows } = await db.query<{ executions: number }>(
    `insert into tool_executions (conversation_id, call_id, name) values ($1, $2, $3)
     on conflict (conversation_id, call_id) do update set executions = tool_executions.executions + 1, last_at = now()
     returning executions`,
    [input.conversationId, input.callId, input.name],
  );
  return rows[0]?.executions ?? 1;
}
