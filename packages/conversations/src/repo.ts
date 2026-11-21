import type { TenantQueryable } from "@kerby/db";

export type ConversationRecord = {
  id: string;
  externalUserId: string | null;
  model: string;
  system: string;
  lastError: string | null;
  createdAt: Date;
};

type ConversationRow = {
  id: string;
  external_user_id: string | null;
  model: string;
  system: string;
  last_error: string | null;
  created_at: Date;
};

const COLUMNS = "id, external_user_id, model, system, last_error, created_at";

const fromRow = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  externalUserId: row.external_user_id,
  model: row.model,
  system: row.system,
  lastError: row.last_error,
  createdAt: row.created_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A conversation id from a URL is only ever looked up as a uuid; anything else is simply not found. */
export const isConversationId = (value: string): boolean => UUID.test(value);

export async function insertConversation(
  db: TenantQueryable,
  input: { externalUserId?: string | undefined; model: string; system: string },
): Promise<ConversationRecord> {
  const { rows } = await db.query<ConversationRow>(
    `insert into conversations (external_user_id, model, system) values ($1, $2, $3) returning ${COLUMNS}`,
    [input.externalUserId ?? null, input.model, input.system],
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
};

type MessageRow = {
  seq: number;
  role: "user" | "assistant" | "tool";
  blob_id: string;
  run_id: string | null;
  created_at: Date;
};

/** The message index of a conversation after `afterSeq`, oldest first. Bodies live in S3: see `readMessages`. */
export async function listMessageRows(
  db: TenantQueryable,
  conversationId: string,
  afterSeq = 0,
): Promise<MessageRowRecord[]> {
  const { rows } = await db.query<MessageRow>(
    "select seq, role, blob_id, run_id, created_at from messages where conversation_id = $1 and seq > $2 order by seq",
    [conversationId, afterSeq],
  );
  return rows.map((row) => ({
    seq: row.seq,
    role: row.role,
    blobId: row.blob_id,
    runId: row.run_id,
    createdAt: row.created_at,
  }));
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
