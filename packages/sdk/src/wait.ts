// Poll until something finishes: a turn answers, a judgment is decided. Starts quick, backs off, honors the caller's
// signal and a deadline.
import { KerbyTimeoutError } from "./errors.ts";
import { sleep } from "./http.ts";

export type WaitOptions = {
  /** Stop waiting (not the work) after this long and throw `KerbyTimeoutError`. */
  timeoutMs?: number;
  /** Abort the wait: the call rejects with the signal's reason. */
  signal?: AbortSignal;
  /** First delay between checks; it grows by half each time up to `maxPollMs`. Default 250. */
  pollMs?: number;
  /** Longest delay between checks. Default 2000. */
  maxPollMs?: number;
};

export async function pollUntil<T>(
  what: string,
  check: () => Promise<T>,
  isDone: (value: T) => boolean,
  options: WaitOptions & { timeoutMs: number },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const maxPollMs = options.maxPollMs ?? 2000;
  let delay = options.pollMs ?? 250;
  for (;;) {
    const value = await check();
    if (isDone(value)) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new KerbyTimeoutError(
        `${what} did not finish within ${options.timeoutMs} ms; it keeps running, so check it again later`,
      );
    await sleep(Math.min(delay, remaining), options.signal);
    delay = Math.min(Math.round(delay * 1.5), maxPollMs);
  }
}
