// Task names, queues and parameter types: the one place a background job is declared (ADR 0002).
// Params are small JSON: references (ids), never message bodies, which Absurd's retention may delete. The one exception
// is a judgment's request, which is the whole input and which the api bounds (ADR 0015).
import type { JudgmentOutcome, JudgmentRequest } from "@kerby/judgment";

const QUEUES = ["turns", "system", "deliveries"] as const;
export type Queue = (typeof QUEUES)[number];

/** Each task and the queue it runs on. */
export const TASKS = {
  "run-turn": { queue: "turns" },
  /** Shares the `turns` queue, so a judgment counts against the tenant's concurrent turns (ADR 0015). */
  "run-judgment": { queue: "turns" },
  /** Push events to one subscription (ADR 0019); the dispatcher runs these, never the worker. */
  "deliver-events": { queue: "deliveries" },
} as const satisfies Record<string, { queue: Queue }>;

export type TaskName = keyof typeof TASKS;

/** The tasks that run on queue `Q`. */
export type TaskOf<Q extends Queue> = {
  [N in TaskName]: (typeof TASKS)[N]["queue"] extends Q ? N : never;
}[TaskName];

export type TaskParams = {
  /** Continue a conversation after its message `seq` (the user message that caused this turn). */
  "run-turn": { conversationId: string; seq: number };
  /**
   * Judge `state` against `questions` with the model's provider. `prompt` is the decision prompt version the questions
   * and model came from (`PinnedPrompt`, ADR 0017), for `GET /v1/judgments/:id`; tasks from before prompts lack it.
   * `integrationId` started it (ADR 0020): null for a person in the console.
   */
  "run-judgment": JudgmentRequest & {
    prompt?: { name: string; version: number };
    integrationId: string | null;
  };
  /**
   * Deliver events from the log, by id, to a subscription (fan-out, a redelivery), or a test `ping` that is in no log.
   */
  "deliver-events":
    | { subscriptionId: string; eventIds: string[] }
    | { subscriptionId: string; ping: { id: string; createdAt: string } };
};

/** What a task's handler returns: Absurd stores it as the task's result, readable with `readTask`. Small JSON. */
export type TaskResults = {
  // biome-ignore lint/suspicious/noConfusingVoidType: an async handler with no `return` is `Promise<void>`, which `Promise<undefined>` would refuse.
  "run-turn": void;
  "run-judgment": JudgmentOutcome;
  // biome-ignore lint/suspicious/noConfusingVoidType: as for run-turn.
  "deliver-events": void;
};

/** Retry for infrastructure failures (not for refused requests, which end the run normally). */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY = {
  kind: "exponential",
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 300,
} as const;

/**
 * A delivery's retries (ADR 0019): 20 attempts, from 30 s apart doubling up to 6 h apart, about two and a half days
 * in all. An endpoint that is down for an afternoon still gets every event.
 */
export const DELIVERY_RETRY = {
  maxAttempts: 20,
  retry: { kind: "exponential", baseSeconds: 30, factor: 2, maxSeconds: 21_600 },
} as const;
