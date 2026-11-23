// Token buckets kept in this process's memory: the api's per-tenant requests and per-address failed authentications,
// the console's sign-ups and failed sign-ins. Each process counts on its own, so with N processes a key gets up to N
// times the rate; a shared counter is not worth a database round trip per request until pricing (plan 0001, M9) says
// otherwise.

type Bucket = { tokens: number; at: number };

export class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  /**
   * A bucket holds a window's worth of tokens (`windowMs`, default a minute) and refills continuously. `maxKeys`
   * bounds memory: past it the least recently used key is forgotten (it starts again with a full bucket).
   */
  constructor(options: { maxKeys: number; windowMs?: number; now?: () => number }) {
    this.#maxKeys = options.maxKeys;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Seconds until `key` has a token, 0 when it has one now; `limit` tokens per window. Looking does not remember a key
   * that has taken nothing.
   */
  wait(key: string, limit: number): number {
    if (!this.#buckets.has(key)) return 0;
    const tokens = this.#refill(key, limit).tokens;
    return tokens >= 1 ? 0 : this.#secondsToOne(tokens, limit);
  }

  /** Take one token: 0 when taken, else the seconds until one is available (nothing taken). */
  take(key: string, limit: number): number {
    const bucket = this.#refill(key, limit);
    if (bucket.tokens < 1) return this.#secondsToOne(bucket.tokens, limit);
    bucket.tokens -= 1;
    return 0;
  }

  #secondsToOne(tokens: number, limit: number): number {
    return Math.ceil(((1 - tokens) * this.#windowMs) / limit / 1000);
  }

  #refill(key: string, limit: number): Bucket {
    const now = this.#now();
    const found = this.#buckets.get(key);
    const bucket = found ?? { tokens: limit, at: now };
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.at) * limit) / this.#windowMs);
    bucket.at = now;
    // Re-insert so the map's order is least recently used first.
    this.#buckets.delete(key);
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > this.#maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    return bucket;
  }
}

/**
 * Work that takes turns per key: at most `perKey` runs of one key at once, the rest wait in arrival order; other keys
 * are not held up. A limiter that counts outcomes (failed authentications) checks its count when a run's turn comes,
 * so a concurrent burst cannot all pass the check before the first outcome is known, while honest concurrency waits a
 * moment instead of being refused. Keys are forgotten when nothing runs or waits for them.
 */
export class TurnsPerKey {
  readonly #perKey: number;
  readonly #keys = new Map<string, { running: number; waiting: (() => void)[] }>();

  constructor(perKey: number) {
    this.#perKey = perKey;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let turns = this.#keys.get(key);
    if (!turns) {
      turns = { running: 0, waiting: [] };
      this.#keys.set(key, turns);
    }
    if (turns.running < this.#perKey) turns.running++;
    else {
      const { promise, resolve } = Promise.withResolvers<void>();
      turns.waiting.push(resolve);
      await promise;
    }
    try {
      return await fn();
    } finally {
      // The finished run's place goes to the longest-waiting one, or is given up.
      const next = turns.waiting.shift();
      if (next) next();
      else if (--turns.running === 0) this.#keys.delete(key);
    }
  }
}

/**
 * The client's address. Behind a trusted proxy (Railway's edge overwrites `X-Forwarded-For` and puts the client
 * first), the left-most entry of `forwardedFor`; otherwise the socket's peer, since anyone can send the header.
 */
export function clientAddress(
  forwardedFor: string | null | undefined,
  socketAddress: string,
  trustProxy: boolean,
): string {
  if (!trustProxy) return socketAddress;
  const first = forwardedFor?.split(",")[0]?.trim();
  return first ? first : socketAddress;
}
