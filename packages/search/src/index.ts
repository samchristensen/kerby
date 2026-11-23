// The chat search index (ADR 0021): its tenant tables, how messages become chunks, and the queries that build and
// search it. Embedding is not done here: the caller brings vectors from an `EmbeddingProvider`.
import { join } from "node:path";

export const searchMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

export { chunkText, indexableText } from "./chunk.ts";
export { readHits, type SearchHitRecord, type SearchHitRef, searchChunks } from "./query.ts";
export {
  chunksToEmbed,
  conversationIdsAfter,
  indexedSeq,
  type MessageChunks,
  writeChunks,
  writeEmbeddings,
} from "./repo.ts";
export { indexCounts, readSearchSettings, setEmbeddingModel, setIndexError } from "./settings.ts";
