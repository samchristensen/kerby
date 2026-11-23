// The port between Kerby and any embedding provider (ADR 0021). Types only: nothing here names a provider or its SDK.
// An adapter (`packages/embeddings-<wire format>`) maps one provider onto this contract; the chat search index and its
// queries see only these types. The development and test fake lives at `@kerby/embeddings/fake`.

/**
 * Texts to embed and what they are embedded with. There is no tenant, user, or conversation id here, by design: a
 * provider that never sees them cannot cross them. Kerby's closures carry them.
 */
export type EmbeddingRun = {
  /** A Kerby model id, `<provider>/<modelId>`; the adapter sends `<modelId>` to the provider `id` names. */
  model: string;
  /** One vector per input, in order. Non-empty; an adapter may refuse a batch its provider would. */
  inputs: string[];
  /**
   * The caller's own API key for the model's provider (bring your own key), opened for this run only. An adapter hands
   * it to the provider and nowhere else: not to a log, an error, or an outcome.
   */
  apiKey?: string;
  signal: AbortSignal;
};

/**
 * `embedded`: exactly one vector per input, in input order, all of one length. `model` is the model that answered, as a
 * Kerby model id. `refused`: the provider rejected the request itself (a bad key, an unknown model, an input too long),
 * so a retry gets the same answer; `error` says why and never holds the key.
 */
export type EmbeddingOutcome =
  | {
      type: "embedded";
      model: string;
      vectors: number[][];
      usage: { inputTokens: number };
    }
  | { type: "refused"; error: string };

/**
 * An embedding provider behind the port. Infrastructure failures (network, a provider outage, rate limiting) throw so
 * the task retries; a request the provider rejected on its merits returns `refused`.
 */
export interface EmbeddingProvider {
  /** The provider id in Kerby model ids: `openai` in `openai/text-embedding-3-small`. */
  readonly id: string;
  embed(run: EmbeddingRun): Promise<EmbeddingOutcome>;
}
