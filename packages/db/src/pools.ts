// An LRU of small pools, one per tenant database (plan 0001, S5: 50 pools serve 1000 databases, cold open 5.7 ms).
// A pool is leased for the duration of `use`; only idle pools are evicted, so a long run never loses its
// connection to eviction. The cap is soft while every pool is leased.
import { errorFields, log } from "@kerby/observability";
import { type ClosableTenantDb, createTenantDb, type TenantDb } from "./handles.ts";

export type TenantPoolsOptions = {
  /**
   * Where a tenant's database lives, with its role's current password. Called on a cold open and at every later login
   * of the pool, so a rotated password (ADR 0009) needs no new pool: a run, and Absurd, may hold this one.
   */
  resolveUrl(tenantId: string): Promise<string>;
  /** Pools kept open at once. Default 50. */
  maxPools?: number;
  /** Connections per tenant pool. Default 2. */
  connectionsPerPool?: number;
  idleTimeoutMillis?: number;
};

/** A leased tenant handle: valid until `release()`. */
export type TenantLease = { db: TenantDb; release(): Promise<void> };

type Entry = {
  db: Promise<ClosableTenantDb>;
  leases: number;
  lastUsed: number;
  /** Closes as soon as the last lease ends (evicted or tenant removed while in use). */
  doomed: boolean;
};

export class TenantPools {
  readonly #options: TenantPoolsOptions;
  readonly #entries = new Map<string, Entry>();
  #closed = false;

  constructor(options: TenantPoolsOptions) {
    this.#options = options;
  }

  /** Run `fn` with the tenant's handle. The handle is valid only until `fn` settles. */
  async use<T>(tenantId: string, fn: (db: TenantDb) => Promise<T>): Promise<T> {
    const lease = await this.acquire(tenantId);
    try {
      return await fn(lease.db);
    } finally {
      await lease.release();
    }
  }

  /**
   * Lease the tenant's handle for as long as the caller needs it (a stream outliving one call). The pool is not
   * evicted until `release`, which must be called exactly once.
   */
  async acquire(tenantId: string): Promise<TenantLease> {
    if (this.#closed) throw new Error("TenantPools is closed");
    let entry = this.#entries.get(tenantId);
    if (!entry) {
      this.#evictIdle((this.#options.maxPools ?? 50) - 1);
      const { resolveUrl, connectionsPerPool = 2, idleTimeoutMillis } = this.#options;
      entry = {
        db: resolveUrl(tenantId).then((url) =>
          createTenantDb(url, {
            max: connectionsPerPool,
            ...(idleTimeoutMillis === undefined ? {} : { idleTimeoutMillis }),
            refreshUrl: () => resolveUrl(tenantId),
          }),
        ),
        leases: 0,
        lastUsed: 0,
        doomed: false,
      };
      this.#entries.set(tenantId, entry);
    }
    const held = entry;
    held.leases++;
    const release = async () => {
      held.leases--;
      held.lastUsed = performance.now();
      if (held.leases === 0 && held.doomed) await this.#close(held);
      else this.#evictIdle(this.#options.maxPools ?? 50);
    };
    try {
      return { db: await held.db, release };
    } catch (error) {
      // A failed open must not poison the slot.
      if (this.#entries.get(tenantId) === held) this.#entries.delete(tenantId);
      held.leases--;
      throw error;
    }
  }

  /** Forget a tenant's pool (deleted or moved; a rotated password needs no eviction). Closes once no run holds it. */
  async evict(tenantId: string): Promise<void> {
    const entry = this.#entries.get(tenantId);
    if (!entry) return;
    this.#entries.delete(tenantId);
    entry.doomed = true;
    if (entry.leases === 0) await this.#close(entry);
  }

  get size(): number {
    return this.#entries.size;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => this.#close(entry)));
  }

  /** Evict least-recently-used idle pools until at most `keep` remain (or none is idle). */
  #evictIdle(keep: number): void {
    while (this.#entries.size > keep) {
      let oldest: [string, Entry] | undefined;
      for (const candidate of this.#entries) {
        if (candidate[1].leases > 0) continue;
        if (!oldest || candidate[1].lastUsed < oldest[1].lastUsed) oldest = candidate;
      }
      if (!oldest) return;
      this.#entries.delete(oldest[0]);
      void this.#close(oldest[1]);
    }
  }

  async #close(entry: Entry): Promise<void> {
    try {
      await (await entry.db).close();
    } catch (error) {
      log("warn", "closing a tenant pool failed", errorFields(error));
    }
  }
}
