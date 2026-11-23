import type { Judgment } from "@kerby/contracts/tenant";

// Every failure the SDK raises is a `KerbyError`, so one `catch` can tell Kerby's failures from the caller's own bugs.
// A caller that aborts through its own `AbortSignal` gets the signal's reason back unchanged, never one of these.

export class KerbyError extends Error {
  override name = "KerbyError";
}

/**
 * The API answered with a non-2xx status. `code` is the API's stable machine-readable error code (`not_found`,
 * `conversation_busy`, `forbidden`, ...): branch on it, never on `message`, which is for people.
 */
export class KerbyApiError extends KerbyError {
  override name = "KerbyApiError";
  readonly status: number;
  readonly code: string;
  readonly method: string;
  readonly path: string;
  /** Per-item reasons, for the codes that carry them (`unknown_tool`). */
  readonly problems: unknown;
  /** From the `Retry-After` header of a 429, in seconds. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    method: string;
    path: string;
    problems?: unknown;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.method = init.method;
    this.path = init.path;
    this.problems = init.problems;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** Narrow an unknown `catch` value to an API error, optionally one with a given `code`. */
export function isKerbyApiError(error: unknown, code?: string): error is KerbyApiError {
  return error instanceof KerbyApiError && (code === undefined || error.code === code);
}

/** No usable answer arrived: the network failed, or the connection dropped. The request may or may not have been processed. */
export class KerbyConnectionError extends KerbyError {
  override name = "KerbyConnectionError";
}

/** A request, or a wait for a turn or judgment, took longer than its time limit. */
export class KerbyTimeoutError extends KerbyConnectionError {
  override name = "KerbyTimeoutError";
}

/**
 * The API answered 2xx, but the body is not what the contract says: this SDK is older or newer than the API.
 * Update the SDK, or pass `validateResponses: false` to read bodies as they came.
 */
export class KerbyResponseError extends KerbyError {
  override name = "KerbyResponseError";
  readonly method: string;
  readonly path: string;

  constructor(message: string, method: string, path: string) {
    super(message);
    this.method = method;
    this.path = path;
  }
}

/** A turn ended without an answer: the provider refused it, or it failed for good. `message` is the API's reason. */
export class KerbyTurnError extends KerbyError {
  override name = "KerbyTurnError";
  readonly conversationId: string;
  /** The user message the turn answered. */
  readonly seq: number;

  constructor(message: string, conversationId: string, seq: number) {
    super(message);
    this.conversationId = conversationId;
    this.seq = seq;
  }
}

/** A judgment ended `refused` (the provider rejected the request: posting it again gets the same result) or `failed` (an outage: it may succeed again). */
export class KerbyJudgmentError extends KerbyError {
  override name = "KerbyJudgmentError";
  readonly judgment: Extract<Judgment, { status: "refused" | "failed" }>;

  constructor(judgment: Extract<Judgment, { status: "refused" | "failed" }>) {
    super(`judgment ${judgment.id} ${judgment.status}: ${judgment.error}`);
    this.judgment = judgment;
  }
}
