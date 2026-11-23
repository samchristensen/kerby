// The port between Kerby and any judgment provider (ADR 0015). Types only: nothing here names a provider or its
// SDK, and nothing may. A judgment is a typed answer to a narrow question about some state: which of these options,
// how likely is this statement, how far along this scale. Code owns the workflow; the provider supplies the
// semantic understanding and a probability for every answer. An adapter (`packages/judgment-<provider>`) maps one
// provider onto this contract; everything else in Kerby sees only these types.

/** JSON: what `state`, `instructions` and `criteria` are made of. Never a function, `undefined` or a class. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * One narrow question about the state. `instructions` says what to decide and may refer to state with backticked
 * paths (`ticket.messages[0].text`); `criteria` defines the possible answers. Ask one coherent judgment per question.
 */
export type Question =
  /** How likely is this statement true (yes)? `criteria` says what counts as yes and as no. */
  | {
      type: "noul";
      instructions: JsonValue;
      criteria?: { true?: JsonValue; false?: JsonValue };
    }
  /** Which one of the named options? Each entry maps an option's name to when it applies. */
  | { type: "choice"; instructions: JsonValue; criteria: Record<string, JsonValue> }
  /** How far along an ordered scale? `criteria[i]` describes level `i`, from 0. */
  | { type: "score"; instructions: JsonValue; criteria: JsonValue[] };

/**
 * An answer, matching its question's type. Every probability is in 0 to 1. A provider that cannot give calibrated
 * probabilities does not implement this port: callers threshold on them.
 */
export type Answer =
  /** The probability that the statement is true. Near 0.5 means unsure, not "somewhat". */
  | { type: "noul"; probability: number }
  /**
   * The most probable option; `probabilities` holds every option and sums to about 1. `confidence` is how far the
   * distribution is from an even split (0) toward one option (1).
   */
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  /**
   * The probability-weighted level (it may fall between levels); `probabilities[i]` is level `i`'s probability and
   * sums to about 1. `confidence` is 1 when all probability sits on one level, lower the more it spreads.
   */
  | { type: "score"; score: number; confidence: number; probabilities: number[] };

/** What to judge. */
export type JudgmentRequest = {
  /** A Kerby model id, `<provider>/<modelId>`; the adapter maps it to its provider. */
  model: string;
  /** Everything the questions refer to: text, or structured fields. Give each question only what it needs. */
  state: JsonValue;
  /** Named questions, answered independently and in parallel: no answer sees another. */
  questions: Record<string, Question>;
};

/**
 * A request and what it is run with. There is no tenant, user, or conversation id here, by design: a provider that
 * never sees them cannot cross them. Kerby's closures carry them.
 */
export type JudgmentRun = JudgmentRequest & {
  /**
   * The caller's own API key for the model's provider (bring your own key), opened for this run only. An adapter hands
   * it to the provider and nowhere else: not to a log, an error, or an answer.
   */
  apiKey?: string;
  signal: AbortSignal;
};

type JudgmentUsage = { inputTokens: number; outputTokens: number };

/**
 * `answered`: one answer per question, no more and no fewer. `model` is the model that answered, which may differ from
 * the alias asked for. `refused`: the provider rejected the request itself (a bad key, an invalid question), so a
 * retry gets the same answer; `error` says why and never holds the key.
 */
export type JudgmentOutcome =
  | {
      type: "answered";
      model: string;
      answers: Record<string, Answer>;
      usage: JudgmentUsage;
    }
  | { type: "refused"; error: string };

/**
 * A judgment provider behind the port. Infrastructure failures (network, a provider outage, rate limiting) throw so
 * the task retries; a request the provider rejected on its merits returns `refused`.
 */
export interface JudgmentProvider {
  /** The provider id in Kerby model ids: `typesafe` in `typesafe/jev-latest`. */
  readonly id: string;
  judge(run: JudgmentRun): Promise<JudgmentOutcome>;
}
