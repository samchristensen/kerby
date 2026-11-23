// The trace: what a conversation's runs reported, kept beside its messages (ADR 0018). Entries go to S3 a segment at a
// time and `trace_segments` indexes them. Nothing here is needed to resume a turn: messages are the record for that.
import { createHash } from "node:crypto";
import type { Blobs } from "@kerby/blobs";
import { type TraceEntry, TraceEntrySchema } from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";

/** The object key of a segment: the run, its first entry and a prefix of the content hash (a retry overwrites itself). */
function segmentKey(conversationId: string, runId: string, firstN: number, sha256: string): string {
  return `conversations/${conversationId}/trace/${runId}-${String(firstN).padStart(8, "0")}-${sha256.slice(0, 16)}.json`;
}

/**
 * Store one run's next entries: the object, then the index row. Entries must be one run's, consecutive. Not fenced: a
 * run that lost its lease still did what it reported. A failure throws, so the caller's turn fails and retries.
 */
export async function appendTrace(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  entries: readonly TraceEntry[],
): Promise<void> {
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last) return;
  if (entries.some((entry, i) => entry.runId !== first.runId || entry.n !== first.n + i))
    throw new RangeError("a trace segment holds one run's entries, consecutive");
  const body = new TextEncoder().encode(JSON.stringify(entries));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const { blobId } = await blobs.put(ctx, {
    kind: "trace",
    key: segmentKey(conversationId, first.runId, first.n, sha256),
    body,
    mediaType: "application/json",
    conversationId,
  });
  await ctx.db.query(
    `insert into trace_segments (conversation_id, run_id, attempt, first_n, last_n, blob_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [conversationId, first.runId, first.attempt, first.n, last.n, blobId],
  );
}

type TracePage = {
  entries: TraceEntry[];
  /** The `after` of the next page; null when this page reaches the newest entry. */
  nextAfter: number | null;
};

type SegmentRow = { segment: string; count: number; blob_id: string };

/**
 * The trace after cursor `after`, in the order it was recorded. A page ends at a whole segment once it holds `limit`
 * entries, so it may hold more. Bodies are fetched eight at a time and validated.
 */
export async function readTrace(
  ctx: TenantContext,
  blobs: Blobs,
  conversationId: string,
  page: { after: number; limit: number },
): Promise<TracePage> {
  if (!Number.isInteger(page.limit) || page.limit < 1)
    throw new RangeError(`a page holds at least one entry, not ${page.limit}`);
  // A segment holds at least one entry, so `limit` segments always fill a page; one more says whether another follows.
  // The id leaves as text (a bigint is a string to `pg`), under another name: `order by id` would sort by the output
  // column, as text, and put segment 10 before segment 7.
  const { rows } = await ctx.db.query<SegmentRow>(
    `select id::text as segment, last_n - first_n + 1 as count, blob_id
       from trace_segments where conversation_id = $1 and id > $2 order by trace_segments.id limit $3`,
    [conversationId, page.after, page.limit + 1],
  );
  let held = 0;
  let included = 0;
  for (const row of rows) {
    if (held >= page.limit) break;
    held += row.count;
    included++;
  }
  const kept = rows.slice(0, included);
  const segments: TraceEntry[][] = new Array(kept.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < kept.length; i = next++) {
      const row = kept[i];
      if (!row) continue;
      const { body } = await blobs.get(ctx, row.blob_id);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (!Array.isArray(parsed)) throw new Error(`trace segment ${row.segment} is not a list`);
      segments[i] = parsed.map((entry) => TraceEntrySchema.parse(entry));
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, kept.length) }, worker));
  const more = rows.length > included;
  return {
    entries: segments.flat(),
    nextAfter: more ? Number(kept.at(-1)?.segment) : null,
  };
}
