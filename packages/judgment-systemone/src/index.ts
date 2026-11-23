// The System One wire format (https://docs.typesafe.ai/api/system-one) behind the JudgmentProvider port (ADR 0015): the
// only place that knows it. System One models (Jev first) answer every question with typed probabilities in about 100 ms.
// Two providers speak it: TypeSafe itself, and OpenCode Console's gateway (https://opencode.ai/docs/console/models/), which
// serves Jev and its own decision models at the same path with the tenant's OpenCode key. One adapter, one provider id each.
import type {
  Answer,
  JudgmentOutcome,
  JudgmentProvider,
  JudgmentRun,
  Question,
} from "@kerby/judgment";
import { z } from "zod";
import type { JudgmentProviderId } from "./provider-ids.ts";

export type SystemOneOptions = {
  /** Where the API lives, without `/v1/systemone`. Defaults to the provider's own; tests point it at a local server. */
  baseUrl?: string;
  /** Longest a request may take, in milliseconds. A timeout throws, so the task retries. Default 30 000. */
  timeoutMs?: number;
};

/** `label` names the provider in messages; `baseUrl` is where `/v1/systemone` lives. */
const PROVIDERS: Record<JudgmentProviderId, { label: string; baseUrl: string }> = {
  typesafe: { label: "TypeSafe", baseUrl: "https://api.typesafe.ai" },
  opencode: { label: "OpenCode", baseUrl: "https://opencode.ai/inference/systemone" },
};

const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest provider message we pass on: the 4xx body is the provider's, and ends up in a tenant-visible field. */
const MAX_ERROR_CHARS = 500;

const WireAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    confidence: z.number(),
    probabilities: z.record(z.string(), z.number()),
  }),
]);

const WireResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), WireAnswerSchema),
  usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
});

type WireAnswer = z.infer<typeof WireAnswerSchema>;

/** Probabilities are 0 to 1 by contract; a rounding error in the last digit must not fail validation downstream. */
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function answerFor(
  label: string,
  name: string,
  question: Question,
  wire: WireAnswer | undefined,
): Answer {
  if (!wire) throw new Error(`${label} returned no answer for question "${name}"`);
  const mismatch = () =>
    new Error(`${label} answered question "${name}" as ${wire.type}, not ${question.type}`);
  switch (question.type) {
    case "noul":
      if (wire.type !== "noul") throw mismatch();
      return { type: "noul", probability: clamp(wire.noul) };
    case "choice":
      if (wire.type !== "choice") throw mismatch();
      return {
        type: "choice",
        choice: wire.choice,
        confidence: clamp(wire.confidence),
        probabilities: Object.fromEntries(
          Object.entries(wire.probabilities).map(([option, p]) => [option, clamp(p)]),
        ),
      };
    case "score": {
      if (wire.type !== "score") throw mismatch();
      // The provider keys levels by their index as text; the port says level `i` is `probabilities[i]`.
      const probabilities = question.criteria.map((_, level) => {
        const p = wire.probabilities[String(level)];
        if (p === undefined)
          throw new Error(`${label}'s answer to "${name}" has no probability for level ${level}`);
        return clamp(p);
      });
      return {
        type: "score",
        score: wire.score,
        confidence: clamp(wire.confidence),
        probabilities,
      };
    }
  }
}

/** A provider's 4xx body as one line of text: FastAPI's `detail` is a string, an object or a list of validation errors. */
function describe(body: unknown): string {
  const detail = typeof body === "object" && body !== null && "detail" in body ? body.detail : body;
  const text = typeof detail === "string" ? detail : (JSON.stringify(detail) ?? "no detail");
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

export function createSystemOneJudgments(
  id: JudgmentProviderId,
  options: SystemOneOptions = {},
): JudgmentProvider {
  const { label, baseUrl } = PROVIDERS[id];
  const endpoint = `${(options.baseUrl ?? baseUrl).replace(/\/+$/, "")}/v1/systemone`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const modelPrefix = `${id}/`;

  return {
    id,
    async judge(run: JudgmentRun): Promise<JudgmentOutcome> {
      const { apiKey } = run;
      if (!run.model.startsWith(modelPrefix) || run.model.length === modelPrefix.length)
        return { type: "refused", error: `model "${run.model}" must look like ${id}/<model>` };
      if (!apiKey) return { type: "refused", error: `no ${label} API key` };
      /** The provider's own words can quote the key it rejected; nothing that leaves here may. */
      const scrub = (text: string): string => text.replaceAll(apiKey, "[redacted]");

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        // Never follow a redirect: the key rides in a header the next host would receive.
        redirect: "error",
        signal: AbortSignal.any([run.signal, AbortSignal.timeout(timeoutMs)]),
        body: JSON.stringify({
          model: run.model.slice(modelPrefix.length),
          state: run.state,
          questions: run.questions,
        }),
      }).catch((error: unknown) => {
        // A transport error can carry the request's headers in its cause: keep the message, drop the rest.
        throw new Error(scrub(`${label} request failed: ${String(error)}`));
      });

      if (!response.ok) {
        // Throttling, a conflict, a timeout and any 5xx pass with time: the task retries. Anything else is the
        // request's own fault and the same on every attempt.
        if (response.status >= 500 || [408, 409, 429].includes(response.status))
          throw new Error(`${label} returned HTTP ${response.status}`);
        if (response.status === 401 || response.status === 403)
          return { type: "refused", error: `${label} rejected the API key` };
        const body: unknown = await response.json().catch(() => undefined);
        return {
          type: "refused",
          error: scrub(`${label} refused the request (HTTP ${response.status}): ${describe(body)}`),
        };
      }

      const wire = WireResponseSchema.parse(await response.json());
      const asked = Object.entries(run.questions);
      if (Object.keys(wire.answers).length !== asked.length)
        throw new Error(`${label} answered a different set of questions than were asked`);
      return {
        type: "answered",
        model: wire.model,
        answers: Object.fromEntries(
          asked.map(([name, question]) => [
            name,
            answerFor(label, name, question, wire.answers[name]),
          ]),
        ),
        usage: { inputTokens: wire.usage.input_tokens, outputTokens: wire.usage.output_tokens },
      };
    },
  };
}
