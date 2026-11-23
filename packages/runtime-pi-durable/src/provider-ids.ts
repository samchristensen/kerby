// The ids of the providers a tenant can bring a key for, without the provider code: the api imports this
// (`@kerby/runtime-pi-durable/providers`) to refuse an unknown provider at `PUT /v1/model-keys/:provider`, and must
// not load Pi. `providers.ts` maps each id to its Pi provider; the type of that map keeps the two equal.
export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "cerebras",
  "deepseek",
  "fireworks",
  "google",
  "groq",
  "mistral",
  "openai",
  "opencode",
  "openrouter",
  "together",
  "xai",
] as const;

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const isSupportedProvider = (id: string): id is SupportedProvider =>
  (SUPPORTED_PROVIDERS as readonly string[]).includes(id);
