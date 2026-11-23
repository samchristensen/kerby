// The ids of the embedding providers Kerby speaks the OpenAI embeddings wire format to, without the adapter code: the
// api and the console import this (`@kerby/embeddings-openai/providers`) to accept a search embedding model. `index.ts`
// maps each id to its base URL; the type of that map keeps the two equal.
//
// Each is also a chat provider (`@kerby/runtime-pi-durable/providers`): the tenant stores one key per provider and the
// chat key serves embeddings too. Confirmed against each provider's own docs (2026-11):
// - openai: https://platform.openai.com/docs/api-reference/embeddings (POST https://api.openai.com/v1/embeddings)
// - google: https://ai.google.dev/gemini-api/docs/openai#embeddings (base https://generativelanguage.googleapis.com/v1beta/openai/, Gemini API key)
// - mistral: https://docs.mistral.ai/api/endpoint/embeddings (POST https://api.mistral.ai/v1/embeddings)
// - fireworks: https://docs.fireworks.ai/guides/querying-embeddings-models (base https://api.fireworks.ai/inference/v1)
// - openrouter: https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings (POST https://openrouter.ai/api/v1/embeddings)
// Left out: together, whose embeddings run only on dedicated endpoints (https://docs.together.ai/reference/embeddings),
// so no model id works with a plain chat key.
export const EMBEDDING_PROVIDERS = [
  "openai",
  "google",
  "mistral",
  "fireworks",
  "openrouter",
] as const;

export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDERS)[number];

/** One documented, current embedding model per provider, as a Kerby model id: what the console offers first. */
export const SUGGESTED_EMBEDDING_MODELS: Record<EmbeddingProviderId, string> = {
  openai: "openai/text-embedding-3-small",
  google: "google/gemini-embedding-001",
  mistral: "mistral/mistral-embed",
  fireworks: "fireworks/nomic-ai/nomic-embed-text-v1.5",
  openrouter: "openrouter/openai/text-embedding-3-small",
};
