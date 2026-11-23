// Chat search (ADR 0019): `POST /v1/search` and `GET|PUT /v1/search/settings` on the tenant API.
import { z } from "zod";

/** The most hits one search returns. */
export const MAX_SEARCH_HITS = 50;

/**
 * `POST /v1/search`. The query is a body, not a URL parameter, so it stays out of URLs and access logs. Plain words
 * match; `"quoted phrases"`, `or` and `-excluded` words work as in a web search.
 */
export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  limit: z.number().int().min(1).max(MAX_SEARCH_HITS).default(20),
  /** Only this end user's conversations (the tenant's own name for them, as at conversation creation). */
  externalUserId: z.string().min(1).max(128).optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/** The best-matching piece of one conversation. */
const SearchHitSchema = z.object({
  conversationId: z.uuid(),
  /** The message the match is in. */
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  /** The conversation's title (from its first message), null when it has none. */
  title: z.string().nullable(),
  /** A passage of the message around the match, plain text. */
  snippet: z.string(),
  /** Higher is better; comparable only within one response. */
  score: z.number(),
  /** When the message was written. */
  createdAt: z.iso.datetime(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  /** At most one hit per conversation, best first. */
  hits: z.array(SearchHitSchema),
  /** `hybrid`: words and meaning; `keyword`: words only. */
  mode: z.enum(["hybrid", "keyword"]),
  /** Why a tenant with an embedding model got keyword results (no key, a provider refusal, a timeout); else null. */
  notice: z.string().nullable(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** `PUT /v1/search/settings`. `null` turns semantic search off; the keyword index is always kept. */
export const PutSearchSettingsRequestSchema = z.object({
  /** A Kerby model id, `<provider>/<modelId>`, of an embedding model; the tenant must hold a key for the provider. */
  embeddingModel: z.string().min(1).max(200).nullable(),
});

/** `GET|PUT /v1/search/settings`. `updatedAt` is when the embedding model was last set, null until it first is. */
export const SearchSettingsSchema = z.object({
  embeddingModel: z.string().nullable(),
  /** Why the last indexing pass could not embed (no key, a refusal); null when it could, or no model is set. */
  lastError: z.string().nullable(),
  /** How much of the tenant's chats is indexed: chunks of text, and those embedded with the current model. */
  chunks: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;
