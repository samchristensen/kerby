// Token buckets kept in this process's memory: per tenant for requests, per client address for failed
// authentications. Each api process counts on its own, so with N processes a key gets up to N times the rate; a shared
// counter is not worth a database round trip per request until pricing (plan 0001, M9) says otherwise.

type Bucket = { tokens: number; at: number };

export class TokenBuckets {
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;
  readonly #now: () => number;

  /** `maxKeys` bounds memory: past it the least recently used key is forgotten (it starts again with a full bucket). */
  constructor(options: { maxKeys: number; now?: () => number }) {
    this.#maxKeys = options.maxKeys;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Seconds until `key` has a token, 0 when it has one now. A bucket holds a minute's worth (`perMinute`) and refills
   * continuously; it starts full. Looking does not remember a key that has taken nothing.
   */
  wait(key: string, perMinute: number): number {
    if (!this.#buckets.has(key)) return 0;
    const tokens = this.#refill(key, perMinute).tokens;
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 60) / perMinute);
  }

  /** Take one token: 0 when taken, else the seconds until one is available (nothing taken). */
  take(key: string, perMinute: number): number {
    const bucket = this.#refill(key, perMinute);
    if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * 60) / perMinute);
    bucket.tokens -= 1;
    return 0;
  }

  #refill(key: string, perMinute: number): Bucket {
    const now = this.#now();
    const found = this.#buckets.get(key);
    const bucket = found ?? { tokens: perMinute, at: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) * perMinute) / 60_000);
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
 * The client's address. Behind a trusted proxy (Railway's edge overwrites `X-Forwarded-For` and puts the client
 * first), the left-most entry; otherwise the socket's peer, since anyone can send the header.
 */
export function clientAddress(
  request: Request,
  socketAddress: string,
  trustProxy: boolean,
): string {
  if (!trustProxy) return socketAddress;
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first : socketAddress;
}
