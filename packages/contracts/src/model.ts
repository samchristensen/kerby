// Kerby model ids and tenants' own model keys (bring your own key). A model id is `<provider>/<modelId>`; the
// provider says whose key a run uses. Which providers exist is the harness adapter's business, not Kerby's.
import { z } from "zod";

const PROVIDER = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const ModelProviderSchema = z
  .string()
  .regex(PROVIDER, "a provider id is lower-case letters, digits and hyphens, up to 40 characters");

/** `anthropic/claude-x` -> `{ provider: "anthropic", modelId: "claude-x" }`; undefined when it has no provider. */
export function parseModelId(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const provider = model.slice(0, slash);
  return PROVIDER.test(provider) ? { provider, modelId: model.slice(slash + 1) } : undefined;
}

/** Printable ASCII without spaces: every provider's keys are, and anything else is a header-injection risk. */
export const PutModelKeyRequestSchema = z.object({
  apiKey: z
    .string()
    .min(8)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/, "an API key is printable ASCII without spaces"),
});

/** What the API says about a stored key: which provider and when. The key itself is never returned. */
const ModelKeySchema = z.object({
  provider: ModelProviderSchema,
  createdAt: z.iso.datetime(),
});

export const ListModelKeysResponseSchema = z.object({ keys: z.array(ModelKeySchema) });
export type ListModelKeysResponse = z.infer<typeof ListModelKeysResponseSchema>;
