import { type EventEnvelope, EventEnvelopeSchema } from "@kerby/contracts";
import type { TenantQueryable } from "@kerby/db";

/** The LISTEN channel for one conversation in its tenant's database. `[a-z0-9_]`, so safe as an identifier. */
export function conversationChannel(conversationId: string): string {
  return `c_${conversationId.replaceAll("-", "").toLowerCase()}`;
}

/** NOTIFY payloads are limited to 8000 bytes. */
const MAX_PAYLOAD_BYTES = 7500;

/** What a listener receives: a pointer to a persisted message, or a live (ephemeral) event. */
export type ConversationNotice = { persisted: number } | { live: EventEnvelope };

/**
 * Announce a live event (a text delta, a tool start) to the conversation's listeners. Ephemeral: a listener that is
 * not connected misses it, and one too large for NOTIFY is dropped (the persisted message carries the content).
 * Returns whether it was sent.
 */
export async function notifyLive(
  db: TenantQueryable,
  conversationId: string,
  envelope: EventEnvelope,
): Promise<boolean> {
  const payload = JSON.stringify({ live: envelope } satisfies ConversationNotice);
  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) return false;
  await db.query("select pg_notify($1, $2)", [conversationChannel(conversationId), payload]);
  return true;
}

/** Parse a notification payload; undefined for anything that is not ours. */
export function parseNotice(payload: string): ConversationNotice | undefined {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null) return undefined;
    if ("persisted" in value && typeof value.persisted === "number")
      return { persisted: value.persisted };
    if ("live" in value) {
      const parsed = EventEnvelopeSchema.safeParse(value.live);
      if (parsed.success) return { live: parsed.data };
    }
  } catch {
    // not JSON
  }
  return undefined;
}
