// The OpenAI embeddings wire format (https://platform.openai.com/docs/api-reference/embeddings) behind the
// EmbeddingProvider port (ADR 0021): the only place that knows it. Several providers serve it at `<base>/embeddings`
// with their chat key; `provider-ids.ts` lists them and where each was confirmed. One adapter, one provider id each.
import type { EmbeddingOutcome, EmbeddingProvider, EmbeddingRun } from "@kerby/embeddings";
import { z } from "zod";
import type { EmbeddingProviderId } from "./provider-ids.ts";

export type OpenAiEmbeddingsOptions = {
  /** Where `/embeddings` lives. Defaults to the provider's own; tests point it at a local server. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Longest a request may take, in milliseconds. A timeout throws, so the task retries. Default 30 000. */
  timeoutMs?: number;
};

/** `label` names the provider in messages; `baseUrl` is where `/embeddings` lives. */
const PROVIDERS: Record<EmbeddingProviderId, { label: string; baseUrl: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  google: { label: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  fireworks: { label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  opencode: { label: "OpenCode", baseUrl: "https://opencode.ai/inference/openai/v1" },
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest provider message we pass on: the 4xx body is the provider's, and ends up in a tenant-visible field. */
const MAX_ERROR_CHARS = 500;
/** OpenAI takes up to 2048 inputs, others far fewer (Google 100); callers batch below the smallest. */
const MAX_EMBEDDING_INPUTS = 96;

const WireResponseSchema = z.object({
  data: z
    .array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }))
    .min(1),
  // Not every compatible provider reports usage; a missing count costs nothing but the meter.
  usage: z.object({ prompt_tokens: z.number().int().nonnegative() }).partial().optional(),
});

/** A provider's 4xx body as one line: OpenAI's `{error: {message}}`, a bare `{message}`/`{detail}`, or anything else. */
function describe(body: unknown): string {
  let detail: unknown = body;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "object" && error !== null && "message" in error) detail = error.message;
    else if (typeof error === "string") detail = error;
    else if ("message" in record) detail = record.message;
    else if ("detail" in record) detail = record.detail;
  }
  const text = (typeof detail === "string" ? detail : (JSON.stringify(detail) ?? "no detail"))
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

export function createOpenAiEmbeddings(
  id: EmbeddingProviderId,
  options: OpenAiEmbeddingsOptions = {},
): EmbeddingProvider {
  const { label, baseUrl } = PROVIDERS[id];
  const endpoint = `${(options.baseUrl ?? baseUrl).replace(/\/+$/, "")}/embeddings`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  const modelPrefix = `${id}/`;

  return {
    id,
    async embed(run: EmbeddingRun): Promise<EmbeddingOutcome> {
      const { apiKey } = run;
      if (!run.model.startsWith(modelPrefix) || run.model.length === modelPrefix.length)
        return { type: "refused", error: `model "${run.model}" must look like ${id}/<model>` };
      if (run.inputs.length === 0) return { type: "refused", error: "no inputs to embed" };
      if (run.inputs.length > MAX_EMBEDDING_INPUTS)
        return {
          type: "refused",
          error: `${run.inputs.length} inputs in one request; send at most ${MAX_EMBEDDING_INPUTS}`,
        };
      if (!apiKey) return { type: "refused", error: `no ${label} API key` };
      /** The provider's own words can quote the key it rejected; nothing that leaves here may. */
      const scrub = (text: string): string => text.replaceAll(apiKey, "[redacted]");

      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        // Never follow a redirect: the key rides in a header the next host would receive.
        redirect: "error",
        signal: AbortSignal.any([run.signal, AbortSignal.timeout(timeoutMs)]),
        body: JSON.stringify({
          model: run.model.slice(modelPrefix.length),
          input: run.inputs,
          encoding_format: "float",
        }),
      }).catch((error: unknown) => {
        // A transport error can carry the request's headers in its cause: keep the message, drop the rest.
        throw new Error(scrub(`${label} embeddings request failed: ${String(error)}`));
      });

      if (!response.ok) {
        // Throttling, a conflict, a timeout and any 5xx pass with time: the task retries. Anything else is the
        // request's own fault and the same on every attempt.
        if (response.status >= 500 || [408, 409, 429].includes(response.status))
          throw new Error(`${label} embeddings returned HTTP ${response.status}`);
        const body: unknown = await response.json().catch(() => undefined);
        return {
          type: "refused",
          error: scrub(
            `${label} refused the embeddings request (HTTP ${response.status}): ${describe(body)}`,
          ),
        };
      }

      const parsed = WireResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success)
        throw new Error(
          `${label} embeddings response is not in the OpenAI format: ${parsed.error.message}`,
        );
      const data = [...parsed.data.data].sort((a, b) => a.index - b.index);
      if (data.length !== run.inputs.length || data.some((item, i) => item.index !== i))
        throw new Error(
          `${label} returned ${data.length} embeddings for ${run.inputs.length} inputs, or with gaps in their indexes`,
        );
      const dimensions = data[0]?.embedding.length ?? 0;
      if (dimensions === 0) throw new Error(`${label} returned an empty embedding`);
      for (const item of data) {
        if (item.embedding.length !== dimensions)
          throw new Error(
            `${label} returned embeddings of different lengths (${dimensions} and ${item.embedding.length})`,
          );
        if (!item.embedding.every(Number.isFinite))
          throw new Error(`${label} returned an embedding with a non-finite number`);
      }
      return {
        type: "embedded",
        // The model asked for, not the provider's echo (which some rename): the index keys vectors by this id.
        model: run.model,
        vectors: data.map((item) => item.embedding),
        usage: { inputTokens: parsed.data.usage?.prompt_tokens ?? 0 },
      };
    },
  };
}
