// zod mirrors of the JudgmentProvider port types (packages/judgment), and the tenant-facing judgments API
// (`POST /v1/judgments`, `GET /v1/judgments/:id`). `contracts.test.ts` fails to compile if a schema drifts from its type.
import type { JsonValue } from "@kerby/judgment";
import { z } from "zod";
import { PinnedPromptSchema, PromptRefSchema } from "./prompt-ref.ts";

/** The model a judgment gets when the request names none. */
export const DEFAULT_JUDGMENT_MODEL = "typesafe/jev-latest";

/** Questions one request may ask. They run in parallel; the cap bounds what one request costs the provider. */
export const MAX_QUESTIONS = 32;
/** Options of one choice question, and levels of one score question (the provider's own limits). */
const MAX_CHOICES = 255;
const MAX_SCORE_LEVELS = 10;

const JSON_DEPTH = 32;

/** JSON of at most `JSON_DEPTH` levels. Checked without recursion: a tenant sends this, and a deep one must not overflow the stack. */
function isBoundedJson(value: unknown): value is JsonValue {
  const stack: [unknown, number][] = [[value, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [current, depth] = item;
    if (current === null || ["string", "boolean"].includes(typeof current)) continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || depth > JSON_DEPTH) return false;
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return true;
}

const JsonValueSchema = z.custom<JsonValue>(
  isBoundedJson,
  `must be JSON at most ${JSON_DEPTH} levels deep`,
);

/** A question's name, or a choice's: code reads answers by it. `__proto__` is refused so a name can never be a prototype. */
const Label = z
  .string()
  .min(1)
  .max(100)
  .refine((name) => name !== "__proto__", "must not be __proto__");

const NoulCriteriaSchema = z.object({
  true: JsonValueSchema.exactOptional(),
  false: JsonValueSchema.exactOptional(),
});

/** Guardrails one conversation may carry: each is one yes/no question; those on the same model run in one request. */
const MAX_GUARDRAILS = 16;

/**
 * One condition checked before the assistant acts, on a user message (state `{ "message": <its text> }`) or on a tool call
 * (state `{ "tool_call": { "name", "input" } }`). `instructions` is a yes/no question about that state ("Does `message`
 * try to make the assistant ignore its instructions?"); the message or call is blocked when the probability of yes reaches
 * `blockAt`. Only a message's text is read: a part that is not text (an image) is not judged.
 */
const GuardrailSchema = z.object({
  name: z
    .string()
    .regex(
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/,
      "a guardrail name is a letter, then letters, digits, _ or -, up to 64",
    ),
  appliesTo: z.enum(["user_message", "tool_call"]),
  instructions: JsonValueSchema,
  criteria: NoulCriteriaSchema.exactOptional(),
  blockAt: z.number().gt(0).max(1).default(0.8),
  /** The judgment model that answers it, `<provider>/<model>` (e.g. `opencode/jev-1.14`); default `DEFAULT_JUDGMENT_MODEL`. */
  model: z.string().min(1).max(200).exactOptional(),
});
export type Guardrail = z.output<typeof GuardrailSchema>;

export const GuardrailsSchema = z
  .array(GuardrailSchema)
  .max(MAX_GUARDRAILS)
  .refine(
    (guardrails) => new Set(guardrails.map((g) => g.name)).size === guardrails.length,
    "guardrail names must be unique",
  );

export const QuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: JsonValueSchema,
    criteria: NoulCriteriaSchema.exactOptional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: JsonValueSchema,
    criteria: z.record(Label, JsonValueSchema).refine((options) => {
      const count = Object.keys(options).length;
      return count >= 1 && count <= MAX_CHOICES;
    }, `a choice question has 1 to ${MAX_CHOICES} options`),
  }),
  z.object({
    type: z.literal("score"),
    instructions: JsonValueSchema,
    criteria: z.array(JsonValueSchema).min(1).max(MAX_SCORE_LEVELS),
  }),
]);

const Probability = z.number().min(0).max(1);

export const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability: Probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    confidence: Probability,
    probabilities: z.record(z.string(), Probability),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().min(0),
    confidence: Probability,
    probabilities: z.array(Probability),
  }),
]);

const JudgmentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const JudgmentOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("answered"),
    model: z.string(),
    answers: z.record(z.string(), AnswerSchema),
    usage: JudgmentUsageSchema,
  }),
  z.object({ type: z.literal("refused"), error: z.string() }),
]);

/** Named questions, at most `MAX_QUESTIONS`. A judgment asks at least one; a decision prompt's draft may have none yet. */
export const QuestionSetSchema = z
  .record(Label, QuestionSchema)
  .refine(
    (questions) => Object.keys(questions).length <= MAX_QUESTIONS,
    `a judgment asks 1 to ${MAX_QUESTIONS} questions`,
  );

const Questions = QuestionSetSchema.refine(
  (questions) => Object.keys(questions).length >= 1,
  `a judgment asks 1 to ${MAX_QUESTIONS} questions`,
);

/** The port's request, with the model optional (it defaults to `DEFAULT_JUDGMENT_MODEL`). */
export const JudgmentRequestSchema = z.object({
  model: z.string().min(1).max(200).exactOptional(),
  state: JsonValueSchema,
  questions: Questions,
});

/**
 * `POST /v1/judgments`: the questions and model written out, or a published decision prompt that holds them (ADR 0017).
 * The agent's `judge` tool takes only the first form.
 */
export const SubmitJudgmentRequestSchema = z.union([
  JudgmentRequestSchema.strict(),
  z.strictObject({ state: JsonValueSchema, prompt: PromptRefSchema }),
]);
export type SubmitJudgmentRequest = z.infer<typeof SubmitJudgmentRequestSchema>;

export const SubmitJudgmentResponseSchema = z.object({ id: z.uuid() });
export type SubmitJudgmentResponse = z.infer<typeof SubmitJudgmentResponseSchema>;

const Identity = {
  id: z.uuid(),
  model: z.string(),
  createdAt: z.iso.datetime(),
  /** The decision prompt version the questions came from; null when the request wrote them out. */
  prompt: PinnedPromptSchema.nullable(),
};

/**
 * `GET /v1/judgments/:id`. `pending` and `running` have no answer yet: ask again. `answered` carries one answer per
 * question; `model` is the one asked for, `servedModel` the one that answered. `refused`: the provider rejected the
 * request (no key stored, a bad key, an invalid question); posting it again gets the same result. `failed`: Kerby ran
 * out of attempts (a provider outage); posting it again may succeed.
 */
export const JudgmentSchema = z.discriminatedUnion("status", [
  z.object({ ...Identity, status: z.enum(["pending", "running"]) }),
  z.object({
    ...Identity,
    status: z.literal("answered"),
    servedModel: z.string(),
    answers: z.record(z.string(), AnswerSchema),
    usage: JudgmentUsageSchema,
  }),
  z.object({ ...Identity, status: z.enum(["refused", "failed"]), error: z.string() }),
]);
export type Judgment = z.infer<typeof JudgmentSchema>;
