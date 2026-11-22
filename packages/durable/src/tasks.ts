// Task names, queues and parameter types: the one place a background job is declared (ADR 0002).
// Params are small JSON references (ids), never message bodies: Absurd's retention may delete them.

const QUEUES = ["turns", "system"] as const;
export type Queue = (typeof QUEUES)[number];

/** Each task and the queue it runs on. */
export const TASKS = {
  "run-turn": { queue: "turns" },
} as const satisfies Record<string, { queue: Queue }>;

export type TaskName = keyof typeof TASKS;

export type TaskParams = {
  /** Continue a conversation after its message `seq` (the user message that caused this turn). */
  "run-turn": { conversationId: string; seq: number };
};

/** Retry for infrastructure failures (not for refused requests, which end the run normally). */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY = {
  kind: "exponential",
  baseSeconds: 5,
  factor: 2,
  maxSeconds: 300,
} as const;
