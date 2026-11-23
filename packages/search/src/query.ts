// Searching the index (ADR 0021): Postgres full-text matches and, with a query embedding, cosine neighbours among
// chunks of the same model, fused by reciprocal rank. Exact scans: there is no ANN index yet.
import type { Visibility } from "@kerby/contracts";
import type { TenantQueryable } from "@kerby/db";
import { vectorLiteral } from "./repo.ts";

/** How many chunks each ranked list contributes before fusion. */
const CANDIDATES = 200;
/** Reciprocal rank fusion's constant: a chunk scores sum(1 / (RRF_K + rank)) over the lists it is in. */
const RRF_K = 60;

export type SearchHitRef = { conversationId: string; seq: number; part: number; score: number };

export type SearchQuery = {
  query: string;
  limit: number;
  /** Only this end user's conversations. */
  externalUserId?: string | null;
  /** The query embedded by `model`: adds the semantic list. */
  embedding?: { model: string; vector: number[] };
};

type HitRow = { conversation_id: string; seq: number; part: number; score: number };

/** The `$n` filter of a visibility: null sees the tenant, an id sees that integration's conversations only (ADR 0020). */
const visibleTo = (visibility: Visibility): string | null =>
  visibility === "tenant" ? null : visibility.integrationId;

/**
 * The best-matching chunk of each matching conversation `visibility` sees, best first, at most `limit`. A query of
 * stopwords only has no keyword matches (not an error); without `embedding` that means no hits.
 */
export async function searchChunks(
  db: TenantQueryable,
  query: SearchQuery,
  visibility: Visibility,
): Promise<SearchHitRef[]> {
  if (!Number.isInteger(query.limit) || query.limit < 1)
    throw new RangeError(`a search returns at least 1 hit, not ${query.limit}`);
  const params: unknown[] = [
    query.query,
    query.externalUserId ?? null,
    query.limit,
    visibleTo(visibility),
  ];
  const scope =
    "($2::text is null or v.external_user_id = $2) and ($4::uuid is null or v.integration_id = $4)";
  let semantic = "";
  if (query.embedding) {
    params.push(
      vectorLiteral(query.embedding.vector),
      query.embedding.model,
      query.embedding.vector.length,
    );
    semantic = `
      union all
      (select c.conversation_id, c.seq, c.part,
              row_number() over (order by c.embedding <=> $5::halfvec, c.conversation_id, c.seq, c.part) as rank
         from search_chunks c join conversations v on v.id = c.conversation_id
        where c.embedding_model = $6 and vector_dims(c.embedding) = $7 and ${scope}
        order by rank limit ${CANDIDATES})`;
  }
  const { rows } = await db.query<HitRow>(
    `with ranked as (
       (select c.conversation_id, c.seq, c.part,
               row_number() over (order by ts_rank_cd(c.tsv, q) desc, c.conversation_id, c.seq, c.part) as rank
          from search_chunks c join conversations v on v.id = c.conversation_id,
               websearch_to_tsquery('english', $1) as q
         where c.tsv @@ q and ${scope}
         order by rank limit ${CANDIDATES})
       ${semantic}
     ),
     fused as (
       select conversation_id, seq, part, sum(1.0 / (${RRF_K} + rank))::float8 as score
         from ranked group by conversation_id, seq, part
     ),
     best as (
       select distinct on (conversation_id) conversation_id, seq, part, score
         from fused order by conversation_id, score desc, seq, part
     )
     select conversation_id, seq, part, score from best
      order by score desc, conversation_id limit $3`,
    params,
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    seq: row.seq,
    part: row.part,
    score: row.score,
  }));
}

export type SearchHitRecord = SearchHitRef & {
  role: "user" | "assistant";
  title: string | null;
  /** Plain text around the match (fragments joined by ` … `); the chunk's opening when no word of the query is in it. */
  snippet: string;
  createdAt: Date;
};

type RecordRow = HitRow & {
  role: "user" | "assistant";
  title: string | null;
  snippet: string;
  created_at: Date;
};

/**
 * What to show for `refs`, in their order. A ref whose chunk is gone (its conversation deleted since), or whose
 * conversation `visibility` does not see, is left out.
 */
export async function readHits(
  db: TenantQueryable,
  query: string,
  refs: readonly SearchHitRef[],
  visibility: Visibility,
): Promise<SearchHitRecord[]> {
  if (refs.length === 0) return [];
  const { rows } = await db.query<RecordRow>(
    `select r.conversation_id, r.seq, r.part, r.score, c.role, v.title, c.created_at,
            ts_headline('english', c.text, websearch_to_tsquery('english', $1),
              'StartSel="", StopSel="", MaxWords=35, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "') as snippet
       from unnest($2::uuid[], $3::int[], $4::int[], $5::float8[]) with ordinality as r(conversation_id, seq, part, score, ord)
       join search_chunks c on c.conversation_id = r.conversation_id and c.seq = r.seq and c.part = r.part
       join conversations v on v.id = r.conversation_id
      where ($6::uuid is null or v.integration_id = $6)
      order by r.ord`,
    [
      query,
      refs.map((ref) => ref.conversationId),
      refs.map((ref) => ref.seq),
      refs.map((ref) => ref.part),
      refs.map((ref) => ref.score),
      visibleTo(visibility),
    ],
  );
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    seq: row.seq,
    part: row.part,
    score: row.score,
    role: row.role,
    title: row.title,
    snippet: row.snippet,
    createdAt: row.created_at,
  }));
}
