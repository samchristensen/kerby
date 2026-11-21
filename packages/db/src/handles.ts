// The two database handles (ADR 0004). They are distinct types on purpose: a repo function that takes a
// `TenantDb` cannot be handed the control plane, and the reverse. Neither exposes a pool or a DSN.
import { errorFields, log } from "@kerby/observability";
import pg from "pg";
import { type ListenOptions, listen, type Subscription } from "./listen.ts";

export type Row = Record<string, unknown>;
export type QueryResult<R extends Row> = { rows: R[]; rowCount: number };

declare const plane: unique symbol;

export interface Queryable {
  query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** Inside `ControlDb.transaction`. */
export interface ControlTx extends Queryable {
  readonly [plane]: "control";
}
/** Inside `TenantDb.transaction`. */
export interface TenantTx extends Queryable {
  readonly [plane]: "tenant";
}

/** LISTEN on a channel over a dedicated connection that reconnects on failure. Payloads are what `pg_notify` sent. */
export interface Listens {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    options?: ListenOptions,
  ): Promise<Subscription>;
}

/** The operator-owned control database: tenants, keys, usage, audit. */
export interface ControlDb extends Queryable, Listens {
  readonly [plane]: "control";
  transaction<T>(fn: (tx: ControlTx) => Promise<T>): Promise<T>;
}
/** One tenant's own database: conversations, messages, blob index, Absurd. */
export interface TenantDb extends Queryable, Listens {
  readonly [plane]: "tenant";
  transaction<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

/**
 * Who a call is for: the verified tenant and its own database. Built by a service from a verified API key,
 * never from a request body. Anything that touches tenant data takes one (ARCHITECTURE.md#tenancy).
 */
export type TenantContext = { readonly tenantId: string; readonly db: TenantDb };

/** A handle usable inside or outside a transaction. */
export type ControlQueryable = ControlDb | ControlTx;
export type TenantQueryable = TenantDb | TenantTx;

export type PoolOptions = { max?: number; idleTimeoutMillis?: number };

// packages/durable needs the pool behind a TenantDb for the Absurd client. Nothing else may.
const pools = new WeakMap<object, pg.Pool>();

/** The pool behind a handle. For `packages/durable` only: repo code takes the handle, never the pool. */
export function rawPool(db: ControlDb | TenantDb): pg.Pool {
  const pool = pools.get(db);
  if (!pool) throw new Error("rawPool: not a handle created by @kerby/db");
  return pool;
}

async function run<R extends Row>(
  target: Pick<pg.Pool, "query">,
  text: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  const result = await target.query(text, params ? [...params] : undefined);
  return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
}

type Plain = Queryable &
  Listens & {
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  };

function makeHandle(url: string, options: PoolOptions): Plain {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 10_000,
  });
  // An idle client dying must not crash the process; the next query opens another.
  pool.on("error", (error: Error) =>
    log("warn", "idle database client failed", errorFields(error)),
  );

  const handle: Plain = {
    query: <R extends Row = Row>(text: string, params?: readonly unknown[]) =>
      run<R>(pool, text, params),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("begin");
        const tx: Queryable = {
          query: <R extends Row = Row>(text: string, params?: readonly unknown[]) =>
            run<R>(client, text, params),
        };
        const value = await fn(tx);
        await client.query("commit");
        return value;
      } catch (error) {
        try {
          await client.query("rollback");
        } catch (rollbackError) {
          // The connection is unusable: release it with the error so the pool discards it.
          broken = rollbackError as Error;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    listen: (channel, onNotify, listenOptions) => listen(url, channel, onNotify, listenOptions),
    close: () => pool.end(),
  };
  pools.set(handle, pool);
  return handle;
}

export type ClosableControlDb = ControlDb & { close(): Promise<void> };
export type ClosableTenantDb = TenantDb & { close(): Promise<void> };

export function createControlDb(url: string, options: PoolOptions = {}): ClosableControlDb {
  return makeHandle(url, options) as unknown as ClosableControlDb;
}

/**
 * A handle on one tenant database at `url`, for provisioning and tests. A service gets a `TenantDb` from
 * `TenantPools`, resolved from a verified API key, and never builds one from a URL it was handed.
 */
export function createTenantDb(url: string, options: PoolOptions = { max: 2 }): ClosableTenantDb {
  return makeHandle(url, options) as unknown as ClosableTenantDb;
}
