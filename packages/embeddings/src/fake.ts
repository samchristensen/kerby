// A deterministic embedding provider for the development stack and tests: no network, no key. Feature hashing of words
// gives vectors where texts sharing words are closer than texts that do not, which is all search needs to be exercised.
import type { EmbeddingOutcome, EmbeddingProvider, EmbeddingRun } from "./index.ts";

const DEFAULT_DIMENSIONS = 256;

/** FNV-1a, 32-bit: stable across runs and platforms, unlike anything seeded. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function embedOne(text: string, dimensions: number): { vector: number[]; tokens: number } {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokens) {
    const hash = fnv1a(token);
    // The top bit signs the feature so collisions cancel out on average instead of piling up.
    const slot = hash % dimensions;
    vector[slot] = (vector[slot] ?? 0) + (hash & 0x80000000 ? -1 : 1);
  }
  const norm = Math.hypot(...vector);
  // No words (or words that cancelled out): a fixed unit vector, since a zero vector's cosine distance is NaN.
  if (norm === 0) return { vector: vector.map((_, i) => (i === 0 ? 1 : 0)), tokens: tokens.length };
  return { vector: vector.map((value) => value / norm), tokens: tokens.length };
}

export function createFakeEmbeddings(options: { dimensions?: number } = {}): EmbeddingProvider {
  const dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 1)
    throw new Error(
      `fake embeddings need a positive whole number of dimensions, not ${dimensions}`,
    );
  return {
    id: "fake",
    async embed(run: EmbeddingRun): Promise<EmbeddingOutcome> {
      if (!run.model.startsWith("fake/") || run.model.length === "fake/".length)
        return { type: "refused", error: `model "${run.model}" must look like fake/<model>` };
      const embedded = run.inputs.map((input) => embedOne(input, dimensions));
      return {
        type: "embedded",
        model: run.model,
        vectors: embedded.map((item) => item.vector),
        usage: { inputTokens: embedded.reduce((sum, item) => sum + item.tokens, 0) },
      };
    },
  };
}
