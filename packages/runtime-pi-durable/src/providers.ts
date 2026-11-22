import { type Credential, createModels, type Models, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";

type AnyProvider = Provider;

// Providers a tenant can bring a plain API key for. Cloud-account providers (Bedrock, Vertex, Azure) and OAuth
// logins are left out on purpose: their credentials are not one string, and a tenant's cloud identity is not
// something to hold. Adding a provider is one line here.
const PROVIDERS: Record<string, () => AnyProvider> = {
  anthropic: anthropicProvider,
  cerebras: cerebrasProvider,
  deepseek: deepseekProvider,
  fireworks: fireworksProvider,
  google: googleProvider,
  groq: groqProvider,
  mistral: mistralProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
  together: togetherProvider,
  xai: xaiProvider,
};

export const SUPPORTED_PROVIDERS: readonly string[] = Object.keys(PROVIDERS);

/**
 * Models for one run: a single provider, authenticated with the tenant's own key. The key lives in this object
 * only; nothing is shared between runs or tenants. `undefined` for a provider this adapter does not know.
 */
export function createTenantModels(
  provider: string,
  apiKey: string | undefined,
): Models | undefined {
  const factory = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
  if (!factory || !apiKey) return undefined;
  const instance = factory();
  const credentials = new Map<string, Credential>([
    [instance.id, { type: "api_key", key: apiKey }],
  ]);
  const models = createModels({
    credentials: {
      read: async (providerId) => credentials.get(providerId),
      list: async () => [...credentials].map(([providerId, c]) => ({ providerId, type: c.type })),
      async modify(providerId, fn) {
        const next = await fn(credentials.get(providerId));
        if (next) credentials.set(providerId, next);
        return credentials.get(providerId);
      },
      delete: async (providerId) => void credentials.delete(providerId),
    },
  });
  models.setProvider(instance);
  return models;
}
