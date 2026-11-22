// A Postgres that is starting (a restart, a deploy, a database that was down when this process booted) refuses, hangs
// or resets connections for a while. Nothing has been sent yet, so opening the connection again is safe.
import { setTimeout as sleep } from "node:timers/promises";
import { errorCode } from "@kerby/observability";

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND", // a freshly resolved cluster endpoint
  "57P03", // cannot_connect_now: the database system is starting up
  "08000",
  "08001",
  "08003",
  "08006",
]);

/** Did opening the connection fail in a way that a later attempt can fix? (Never true for a bad password or database.) */
export function isConnectionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined) return RETRYABLE_CODES.has(code);
  const message = error instanceof Error ? error.message : "";
  // pg's own errors for a connect that timed out or was cut before the server answered
  return /timeout exceeded when trying to connect|Connection terminated|connection timeout/i.test(
    message,
  );
}

export type RetryOptions = { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };

/** Run `open` (a connect), retrying connection errors with exponential backoff: about 30 s in total by default. */
export async function withConnectRetry<T>(
  open: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { attempts = 8, baseDelayMs = 500, maxDelayMs = 5000 } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await open();
    } catch (error) {
      if (!isConnectionError(error) || attempt + 1 >= attempts) throw error;
      await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
    }
  }
}
