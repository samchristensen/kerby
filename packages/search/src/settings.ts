// The tenant's one `search_settings` row (ADR 0019): which embedding model indexes its chats, and how indexing went.
import type { TenantQueryable, TenantTx } from "@kerby/db";

export type SearchSettingsRecord = {
  /** A Kerby model id (`openai/text-embedding-3-small`); null: keyword search only. */
  embeddingModel: string | null;
  /** Bumped by every change of model: a backfill spawned for an older generation stops. */
  generation: number;
  /** Why indexing last failed for good with the current model (a provider's refusal); null when it did not. */
  lastError: string | null;
  /** When the embedding model was last set; null until it first is. */
  updatedAt: Date | null;
};

type SettingsRow = {
  embedding_model: string | null;
  generation: number;
  last_error: string | null;
  updated_at: Date | null;
};

const COLUMNS = "embedding_model, generation, last_error, updated_at";

const fromRow = (row: SettingsRow): SearchSettingsRecord => ({
  embeddingModel: row.embedding_model,
  generation: row.generation,
  lastError: row.last_error,
  updatedAt: row.updated_at,
});

function only(rows: SettingsRow[]): SearchSettingsRecord {
  const row = rows[0];
  if (!row)
    throw new Error(
      "search_settings has no row: the search migration inserts it. Fix: migrate the tenant database",
    );
  return fromRow(row);
}

export async function readSearchSettings(db: TenantQueryable): Promise<SearchSettingsRecord> {
  return only((await db.query<SettingsRow>(`select ${COLUMNS} from search_settings`)).rows);
}

/**
 * Choose the embedding model (null: none). A change bumps `generation` and clears `lastError`; choosing the current
 * model again changes nothing, so a repeated request spawns no second backfill. The row is locked until `tx` ends.
 */
export async function setEmbeddingModel(
  tx: TenantTx,
  model: string | null,
): Promise<{ settings: SearchSettingsRecord; changed: boolean }> {
  const current = only(
    (await tx.query<SettingsRow>(`select ${COLUMNS} from search_settings for update`)).rows,
  );
  if (current.embeddingModel === model) return { settings: current, changed: false };
  const { rows } = await tx.query<SettingsRow>(
    `update search_settings
        set embedding_model = $1, generation = generation + 1, last_error = null, updated_at = now()
      returning ${COLUMNS}`,
    [model],
  );
  return { settings: only(rows), changed: true };
}

/**
 * Record (or clear, with null) why indexing with `model` failed for good. Ignored once the tenant has chosen another
 * model: a task still running for the old one must not report on the new one.
 */
export async function setIndexError(
  db: TenantQueryable,
  model: string,
  error: string | null,
): Promise<void> {
  await db.query(
    `update search_settings set last_error = $2
      where embedding_model = $1 and last_error is distinct from $2`,
    [model, error],
  );
}

/** How many chunks the index holds, and how many of them carry an embedding by `model` (0 for null). */
export async function indexCounts(
  db: TenantQueryable,
  model: string | null,
): Promise<{ chunks: number; embedded: number }> {
  const { rows } = await db.query<{ chunks: number; embedded: number }>(
    `select count(*)::int as chunks, count(*) filter (where embedding_model = $1)::int as embedded
       from search_chunks`,
    [model],
  );
  return rows[0] ?? { chunks: 0, embedded: 0 };
}
