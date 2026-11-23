// The event log (ADR 0019): every emitting transaction records its fact here, in the tenant's own database; the api
// reads it (`GET /v1/events`) and the dispatcher fans it out to subscriptions. Both read through `readEvents`, whose
// cursor never skips an event that commits late.
import { join } from "node:path";
import {
  type DeliveryAttempt,
  type EventData,
  type EventType,
  type PublicEvent,
  PublicEventSchema,
  type Visibility,
} from "@kerby/contracts";
import type { ControlQueryable, TenantDb, TenantQueryable } from "@kerby/db";
import { errorFields, log } from "@kerby/observability";

export const eventsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

/** NOTIFYed in the tenant's database after a transaction that recorded an event commits (`announceEvents`). */
const EVENTS_CHANNEL = "events";

/** Who an event is about, its data, and the key that records it once however often its transaction is retried. */
export type NewEvent = {
  [T in EventType]: {
    type: T;
    data: EventData<T>;
    /** The integration whose work it is; null for work a person started in the console. */
    integrationId: string | null;
    dedupeKey: string;
  };
}[EventType];

/**
 * Record an event inside the caller's transaction, so it exists exactly when the change it describes does. A second
 * event with the same `dedupeKey` is ignored. Returns whether this call recorded it. Call `announceEvents` after the
 * commit.
 */
export async function recordEvent(tx: TenantQueryable, event: NewEvent): Promise<boolean> {
  const conversationId = "conversationId" in event.data ? event.data.conversationId : null;
  const { rowCount } = await tx.query(
    `insert into events (type, integration_id, conversation_id, dedupe_key, data)
     values ($1, $2, $3, $4, $5::jsonb) on conflict (dedupe_key) do nothing`,
    [event.type, event.integrationId, conversationId, event.dedupeKey, JSON.stringify(event.data)],
  );
  return rowCount === 1;
}

/**
 * Wake the tenant's event long-polls (`LISTEN events`) once a transaction that recorded events has committed. Never
 * inside the writing transaction: Postgres commits every transaction that sent a NOTIFY one at a time, under a lock the
 * whole cluster shares (see `announcePersisted` in packages/conversations). Best effort: a long-poll re-reads every
 * second anyway, so it never throws. Callers run within their tenant's `withTenant`, which tags the warning.
 */
export async function announceEvents(db: TenantQueryable): Promise<void> {
  try {
    await db.query("select pg_notify($1, '')", [EVENTS_CHANNEL]);
  } catch (error) {
    log("warn", "could not announce new events; long-polls find them within a second", {
      ...errorFields(error),
    });
  }
}

/**
 * Tell the dispatchers a tenant has new events (`LISTEN tenant_events` on the control database). Call after the
 * recording transaction commits. Best effort: a lost notification waits for the dispatchers' sweep, so it never throws.
 */
export async function notifyDispatchers(
  control: ControlQueryable,
  tenantId: string,
): Promise<void> {
  try {
    await control.query("select pg_notify('tenant_events', $1)", [tenantId]);
  } catch (error) {
    log(
      "warn",
      "could not notify dispatchers; their sweep will find the events",
      errorFields(error),
    );
  }
}

/** A position in the log: after `(tx, position)`. Both are 64-bit. */
type Position = { tx: bigint; position: bigint };

function parseCursor(cursor: string): Position {
  const match = /^(\d{1,20})\.(\d{1,19})$/.exec(cursor);
  if (!match?.[1] || !match[2]) throw new Error(`"${cursor}" is not an event cursor`);
  return { tx: BigInt(match[1]), position: BigInt(match[2]) };
}

const formatCursor = (at: Position): string => `${at.tx}.${at.position}`;

/**
 * The oldest transaction still running anywhere on the cluster. Every event of a transaction below it is committed (or
 * never will be), so a reader that stops below it can never be overtaken by a late commit.
 */
async function horizon(db: TenantQueryable): Promise<bigint> {
  const { rows } = await db.query<{ xmin: string }>(
    "select pg_snapshot_xmin(pg_current_snapshot())::text as xmin",
  );
  return BigInt(rows[0]?.xmin ?? "0");
}

/** Which events a read returns. */
export type EventFilter = {
  visibility: Visibility;
  /** Only these types; all when absent. */
  types?: readonly EventType[] | undefined;
  conversationId?: string | undefined;
};

type EventRow = {
  id: string;
  tx: string;
  position: string;
  type: string;
  integration_id: string | null;
  data: unknown;
  created_at: Date;
};

const EVENT_COLUMNS = "id, tx::text, position::text, type, integration_id, data, created_at";

const toPublic = (row: EventRow): PublicEvent =>
  PublicEventSchema.parse({
    id: row.id,
    v: 1,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    integrationId: row.integration_id,
    data: row.data,
  });

/**
 * Up to `limit` events after `cursor` (from the start without one) that `filter` selects, oldest first, and the cursor
 * to read from next. Only events whose transaction is below the horizon are returned, in `(tx, position)` order, so a
 * transaction that commits after this read lands after the returned cursor. A page that is not full moves the cursor
 * to the horizon: events the filter skipped are not scanned again.
 */
export async function readEvents(
  db: TenantQueryable,
  cursor: string | undefined,
  filter: EventFilter,
  limit: number,
): Promise<{ events: PublicEvent[]; next: string }> {
  const from = cursor === undefined ? { tx: 0n, position: 0n } : parseCursor(cursor);
  const xmin = await horizon(db);
  const { rows } = await db.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from events
      where (tx, position) > ($1::xid8, $2::bigint)
        and tx < $3::xid8
        and ($4::uuid is null or integration_id = $4)
        and ($5::text[] is null or type = any($5))
        and ($6::uuid is null or conversation_id = $6)
      order by tx, position
      limit $7`,
    [
      from.tx.toString(),
      from.position.toString(),
      xmin.toString(),
      filter.visibility === "tenant" ? null : filter.visibility.integrationId,
      filter.types ?? null,
      filter.conversationId ?? null,
      limit,
    ],
  );
  const last = rows.at(-1);
  // Every row this read could see lies below the horizon: from there on, nothing is skipped.
  const reached = xmin > from.tx ? { tx: xmin, position: 0n } : from;
  const next =
    rows.length === limit && last
      ? { tx: BigInt(last.tx), position: BigInt(last.position) }
      : reached;
  return { events: rows.map(toPublic), next: formatCursor(next) };
}

/**
 * Are committed events waiting above the horizon, because an older transaction somewhere on the cluster is still open?
 * No reader has returned them yet (a reader stops below the horizon, which only rises), so one that just found nothing
 * new should look again shortly instead of waiting for the next notification: theirs has already been sent.
 */
export async function eventsHeldBack(db: TenantQueryable): Promise<boolean> {
  const { rows } = await db.query<{ held: boolean }>(
    "select exists (select 1 from events where tx >= pg_snapshot_xmin(pg_current_snapshot())) as held",
  );
  return rows[0]?.held ?? false;
}

/**
 * `readEvents`, but when nothing is there yet, wait up to `waitMs` for an event to commit (the long-poll of
 * `GET /v1/events`). The LISTEN starts before the first read, so a commit between them still wakes it. Returns early,
 * empty, when `signal` aborts.
 */
export async function pollEvents(
  db: TenantDb,
  cursor: string | undefined,
  filter: EventFilter,
  limit: number,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ events: PublicEvent[]; next: string }> {
  if (waitMs <= 0) return readEvents(db, cursor, filter, limit);
  let wake = Promise.withResolvers<void>();
  const poke = () => wake.resolve();
  const subscription = await db.listen(EVENTS_CHANNEL, poke, { onReconnect: poke });
  signal.addEventListener("abort", poke, { once: true });
  const deadline = Date.now() + waitMs;
  try {
    let page = await readEvents(db, cursor, filter, limit);
    while (page.events.length === 0 && !signal.aborted && Date.now() < deadline) {
      // A commit may wake this while an older transaction still holds the horizon back: look again shortly.
      const timer = setTimeout(poke, Math.min(1_000, deadline - Date.now()));
      await wake.promise;
      clearTimeout(timer);
      wake = Promise.withResolvers<void>();
      page = await readEvents(db, page.next, filter, limit);
    }
    return page;
  } finally {
    signal.removeEventListener("abort", poke);
    await subscription.close();
  }
}

/** The events with these ids that `visibility` allows, in log order; ids pruned or never recorded are left out. */
export async function findEvents(
  db: TenantQueryable,
  ids: readonly string[],
  visibility: Visibility,
): Promise<PublicEvent[]> {
  const { rows } = await db.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from events where id = any($1::uuid[]) and ($2::uuid is null or integration_id = $2)
      order by tx, position`,
    [ids, visibility === "tenant" ? null : visibility.integrationId],
  );
  return rows.map(toPublic);
}

// Fan-out (the dispatcher): each subscription's place in the log, and its delivery log.

/**
 * Lock a subscription's cursor for one fan-out and return it; a subscription without one starts at the horizon: it gets
 * the events committed from now on. The lock serializes dispatchers fanning out the same subscription.
 */
export async function lockCursor(tx: TenantQueryable, subscriptionId: string): Promise<string> {
  await tx.query(
    `insert into subscription_cursors (subscription_id, tx, position) values ($1, $2::xid8, 0)
     on conflict (subscription_id) do nothing`,
    [subscriptionId, (await horizon(tx)).toString()],
  );
  const { rows } = await tx.query<{ tx: string; position: string }>(
    "select tx::text, position::text from subscription_cursors where subscription_id = $1 for update",
    [subscriptionId],
  );
  const row = rows[0];
  if (!row) throw new Error(`cursor of subscription ${subscriptionId} vanished`);
  return formatCursor({ tx: BigInt(row.tx), position: BigInt(row.position) });
}

/** Forget a deleted subscription's cursor. */
export async function dropCursor(tx: TenantQueryable, subscriptionId: string): Promise<void> {
  await tx.query("delete from subscription_cursors where subscription_id = $1", [subscriptionId]);
}

/** Move a subscription's cursor, in the transaction that locked it. */
export async function saveCursor(
  tx: TenantQueryable,
  subscriptionId: string,
  cursor: string,
): Promise<void> {
  const at = parseCursor(cursor);
  await tx.query(
    "update subscription_cursors set tx = $2::xid8, position = $3, updated_at = now() where subscription_id = $1",
    [subscriptionId, at.tx.toString(), at.position.toString()],
  );
}

export type NewDeliveryAttempt = Omit<DeliveryAttempt, "id" | "at"> & { subscriptionId: string };

export async function recordDeliveryAttempt(
  db: TenantQueryable,
  attempt: NewDeliveryAttempt,
): Promise<void> {
  await db.query(
    `insert into delivery_attempts
       (subscription_id, event_ids, attempt, outcome, will_retry, status, error, response, duration_ms)
     values ($1, $2::uuid[], $3, $4, $5, $6, $7, $8, $9)`,
    [
      attempt.subscriptionId,
      attempt.eventIds,
      attempt.attempt,
      attempt.outcome,
      attempt.willRetry,
      attempt.status,
      attempt.error,
      attempt.response,
      attempt.durationMs,
    ],
  );
}

/** A subscription's delivery attempts, newest first; `before` is a previous page's `nextBefore`. */
export async function listDeliveryAttempts(
  db: TenantQueryable,
  subscriptionId: string,
  page: { limit: number; before?: string | undefined },
): Promise<{ deliveries: DeliveryAttempt[]; nextBefore: string | null }> {
  const { rows } = await db.query<{
    id: string;
    event_ids: string[];
    attempt: number;
    outcome: DeliveryAttempt["outcome"];
    will_retry: boolean;
    status: number | null;
    error: string | null;
    response: string | null;
    duration_ms: number;
    at: Date;
  }>(
    `select id::text, event_ids::text[], attempt, outcome, will_retry, status, error, response, duration_ms, at
       from delivery_attempts
      where subscription_id = $1 and ($2::bigint is null or id < $2)
      order by id desc limit $3`,
    [subscriptionId, page.before ?? null, page.limit + 1],
  );
  const shown = rows.slice(0, page.limit);
  return {
    deliveries: shown.map((row) => ({
      id: row.id,
      eventIds: row.event_ids,
      attempt: row.attempt,
      outcome: row.outcome,
      willRetry: row.will_retry,
      status: row.status,
      error: row.error,
      response: row.response,
      durationMs: row.duration_ms,
      at: row.at.toISOString(),
    })),
    nextBefore: rows.length > page.limit ? (shown.at(-1)?.id ?? null) : null,
  };
}

/** Delete events and delivery attempts older than `maxAgeMs` (retention, ADR 0019). Cursors stay valid. */
export async function pruneEvents(
  db: TenantQueryable,
  maxAgeMs: number,
): Promise<{ events: number; attempts: number }> {
  const seconds = maxAgeMs / 1000;
  const events = await db.query(
    "delete from events where created_at < now() - make_interval(secs => $1::double precision)",
    [seconds],
  );
  const attempts = await db.query(
    "delete from delivery_attempts where at < now() - make_interval(secs => $1::double precision)",
    [seconds],
  );
  return { events: events.rowCount, attempts: attempts.rowCount };
}
