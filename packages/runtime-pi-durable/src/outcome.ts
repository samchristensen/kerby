// Why a Pi input went unanswered, in Kerby's terms. Ported from lochmoore's kerby-worker.

/** HTTP 4xx statuses a later attempt can get past. */
const RETRYABLE_4XX = new Set([408, 409, 429]);

export type UnansweredOutcome = {
  /** The reason, with the provider's own words when it gave any. */
  error: string;
  /** False when the provider refused the request itself (4xx other than timeout, conflict, rate limit). */
  retryable: boolean;
};

/** `detail` is the provider's error text, `"<status> <body>"` for an HTTP error. */
export function classifyUnanswered(reason: string, detail: unknown): UnansweredOutcome {
  if (detail === undefined || detail === null) return { error: reason, retryable: true };
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  const status = Number(/^(\d{3})\b/.exec(text)?.[1]);
  const refused = status >= 400 && status < 500 && !RETRYABLE_4XX.has(status);
  return { error: `${reason}: ${text}`, retryable: !refused };
}
