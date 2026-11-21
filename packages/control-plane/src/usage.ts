import type { ControlQueryable } from "@kerby/db";

export type UsageEntry = {
  tenantId: string;
  /** One row per assistant message: the same key twice is the same usage (the worker retries). */
  dedupeKey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
};

/** Record usage once per `dedupeKey`. Returns whether this call inserted the row. */
export async function recordUsage(db: ControlQueryable, entry: UsageEntry): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into usage (tenant_id, dedupe_key, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, dedupe_key) do nothing`,
    [
      entry.tenantId,
      entry.dedupeKey,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens ?? 0,
      entry.cacheWriteTokens ?? 0,
      entry.costUsd ?? null,
    ],
  );
  return rowCount === 1;
}
