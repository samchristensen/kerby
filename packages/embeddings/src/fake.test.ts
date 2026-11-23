import { describe, expect, it } from "vitest";
import { createFakeEmbeddings } from "./fake.ts";
import type { EmbeddingRun } from "./index.ts";

const run = (inputs: string[], model = "fake/words"): EmbeddingRun => ({
  model,
  inputs,
  signal: new AbortController().signal,
});

const vectorsOf = async (inputs: string[]): Promise<number[][]> => {
  const outcome = await createFakeEmbeddings().embed(run(inputs));
  if (outcome.type !== "embedded") throw new Error(outcome.error);
  return outcome.vectors;
};

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

describe("fake embeddings", () => {
  it("is deterministic and unit length, also for text without words", async () => {
    const inputs = ["The invoice was charged twice", "", "  ?! "];
    const first = await vectorsOf(inputs);
    expect(await vectorsOf(inputs)).toEqual(first);
    for (const vector of first) {
      expect(vector).toHaveLength(256);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    }
  });

  it("puts texts that share words closer than texts that do not", async () => {
    const [query, related, unrelated] = await vectorsOf([
      "refund for a double charge",
      "I want a refund, the charge appeared twice",
      "the weather in Lisbon is sunny",
    ]);
    if (!query || !related || !unrelated) throw new Error("missing vectors");
    expect(cosine(query, related)).toBeGreaterThan(cosine(query, unrelated));
  });

  it("counts tokens and refuses another provider's model", async () => {
    const provider = createFakeEmbeddings({ dimensions: 8 });
    expect(await provider.embed(run(["one two", "three"]))).toMatchObject({
      type: "embedded",
      usage: { inputTokens: 3 },
    });
    expect(await provider.embed(run(["x"], "openai/text-embedding-3-small"))).toMatchObject({
      type: "refused",
    });
  });
});
