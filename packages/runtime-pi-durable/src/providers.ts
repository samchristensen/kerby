import {
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  type Models,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export type ProviderKeys = {
  anthropicApiKey?: string | undefined;
  openaiApiKey?: string | undefined;
};

/** A credential store over a fixed map: the platform's own provider keys, read-only after construction. */
class FixedCredentials implements CredentialStore {
  readonly #credentials: Map<string, Credential>;
  constructor(credentials: Map<string, Credential>) {
    this.#credentials = credentials;
  }
  async read(providerId: string) {
    return this.#credentials.get(providerId);
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.#credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    const next = await fn(this.#credentials.get(providerId));
    if (next) this.#credentials.set(providerId, next);
    return this.#credentials.get(providerId);
  }
  async delete(providerId: string) {
    this.#credentials.delete(providerId);
  }
}

/** Models for the providers whose platform keys are configured. Tenant keys (bring your own) are plan 0001, M9. */
export function createProviderModels(keys: ProviderKeys): Models {
  const credentials = new Map<string, Credential>();
  const providers = [];
  if (keys.anthropicApiKey) {
    const provider = anthropicProvider();
    credentials.set(provider.id, { type: "api_key", key: keys.anthropicApiKey });
    providers.push(provider);
  }
  if (keys.openaiApiKey) {
    const provider = openaiProvider();
    credentials.set(provider.id, { type: "api_key", key: keys.openaiApiKey });
    providers.push(provider);
  }
  const models = createModels({ credentials: new FixedCredentials(credentials) });
  for (const provider of providers) models.setProvider(provider);
  return models;
}
