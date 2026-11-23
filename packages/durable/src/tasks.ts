// Task names, queues and parameter types: the one place a background job is declared (ADR 0002).
// Params are small JSON: references (ids), never message bodies, which Absurd's retention may delete. The one exception
// is a judgment's request, which is the whole input and which the api bounds (ADR 0015).
import type { JudgmentOutcome, JudgmentRequest } from "@kerby/judgment";

const QUEUES = ["turns", "system"] as const;
export type Queue = (typeof QUEUES)[number];

/** Each task and the queue it runs on. */
export const TASKS = {
  "run-turn": { queue: "turns" },
  /** Shares the `turns` queue, so a judgment counts against the tenant's concurrent turns (ADR 0015). */
  "run-judgment": { queue: "turns" },
} as const satisfies Record<string, { queue: Queue }>;

export type TaskName = keyof typeof TASKS;

export type TaskParams = {
  /** Continue a conversation after its message `seq` (the user message that caused this turn). */
  "run-turn": { conversationId: string; seq: number };
  /** Judge `state` against `questions` with the model's provider. */
  "run-judgment": JudgmentRequest;
};

/** What a task's handler returns: Absurd stores it as the task's result, readable with `readTask`. Small JSON. */
export type TaskResults = {
  // biome-ignore lint/suspicious/noConfusingVoidType: an async handler with no `return` is `Promise<void>`, which `Promise<undefined>` would refuse.
  "run-turn": void;
  "run-judgment": JudgmentOutcome;
};

/** Retry for infrastructure failures (not for refused requests, which end the run normally). */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY = {
  kind: "exponential",
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 300,
} as const;
