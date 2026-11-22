// LISTEN/NOTIFY over one dedicated connection per database URL per process (a pooled one would be held for the
// stream's whole life), shared by every subscription on that database: a channel is LISTENed while it has a
// subscriber and UNLISTENed after the last one leaves; the connection closes when no channel is left. A lost
// connection is re-opened with backoff and every channel LISTENed again; `onReconnect` tells each subscriber to
// resync, since notifications sent while disconnected are gone (the callers keep a periodic poll as the backstop).
import { setTimeout as sleep } from "node:timers/promises";
import { errorFields, log } from "@kerby/observability";
import pg from "pg";
import { withConnectRetry } from "./connect-retry.ts";
import type { Credentials } from "./credentials.ts";

export type Subscription = { close(): Promise<void> };
export type ListenOptions = { onReconnect?: () => void };

/** `application_name` of every listening connection: count them in `pg_stat_activity`. */
export const LISTEN_APPLICATION_NAME = "kerby-listen";

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

type Subscriber = { onNotify: (payload: string) => void; onReconnect?: () => void };

/** The one listening connection to a database in this process. */
class Listener {
  readonly #credentials: Credentials;
  /** Channels with at least one subscriber. Everything here is LISTENed on every (re)connected client. */
  readonly #channels = new Map<string, Set<Subscriber>>();
  /** Channels LISTENed on the current client. */
  readonly #listening = new Set<string>();
  #client: pg.Client | undefined;
  /** Settles when a client is connected with every channel listened (rejects if the first connect fails). */
  #ready: Promise<void>;
  #wake: (() => void) | undefined;
  #closed = false;
  readonly #onClosed: () => void;

  constructor(credentials: Credentials, onClosed: () => void) {
    this.#credentials = credentials;
    this.#onClosed = onClosed;
    this.#ready = withConnectRetry(() => this.#connect()).catch(async (error: unknown) => {
      // A password rotated as this login ran: one more try with the new one.
      if (!(await credentials.renew(error))) throw error;
      await withConnectRetry(() => this.#connect());
    });
    // The registry forgets a listener whose first connect failed, so the next subscriber tries afresh.
    this.#ready.then(
      () => void this.#supervise(),
      () => this.#close(),
    );
  }

  /** Resolves once `channel` is LISTENed: a notification sent after that reaches `onNotify`. */
  async subscribe(channel: string, subscriber: Subscriber): Promise<Subscription> {
    let subscribers = this.#channels.get(channel);
    if (!subscribers) {
      subscribers = new Set();
      this.#channels.set(channel, subscribers);
    }
    subscribers.add(subscriber);
    const subscription = { close: () => this.#unsubscribe(channel, subscriber) };
    try {
      for (;;) {
        await this.#ready;
        if (this.#closed) throw new Error("the listening connection closed");
        const client = this.#client;
        // No client: a reconnect is under way, and `#ready` is now its promise; it LISTENs this channel too.
        if (!client) continue;
        if (!this.#listening.has(channel)) {
          await client.query(`listen "${channel}"`);
          if (this.#client === client) this.#listening.add(channel);
        }
        return subscription;
      }
    } catch (error) {
      await subscription.close();
      throw error;
    }
  }

  async #unsubscribe(channel: string, subscriber: Subscriber): Promise<void> {
    const subscribers = this.#channels.get(channel);
    if (!subscribers?.delete(subscriber) || subscribers.size > 0) return;
    this.#channels.delete(channel);
    if (this.#channels.size === 0) return this.#close();
    if (!this.#listening.delete(channel)) return;
    await this.#client
      ?.query(`unlisten "${channel}"`)
      .catch((error: unknown) => log("warn", "unlisten failed", errorFields(error)));
  }

  async #connect(): Promise<void> {
    const next = new pg.Client({
      ...this.#credentials.config,
      application_name: LISTEN_APPLICATION_NAME,
    });
    next.on("notification", (message) => {
      for (const subscriber of this.#channels.get(message.channel) ?? []) {
        try {
          subscriber.onNotify(message.payload ?? "");
        } catch (error) {
          log("warn", "a notification handler failed", errorFields(error));
        }
      }
    });
    next.on("error", (error) => log("warn", "listen connection error", errorFields(error)));
    // `end` also fires after a deliberate close: only an unexpected end triggers a reconnect.
    next.on("end", () => {
      if (!this.#closed && this.#client === next) this.#wake?.();
    });
    try {
      await next.connect();
      const channels = [...this.#channels.keys()];
      for (const channel of channels) await next.query(`listen "${channel}"`);
      this.#listening.clear();
      for (const channel of channels) this.#listening.add(channel);
    } catch (error) {
      await next.end().catch(() => {});
      throw error;
    }
    if (this.#closed) {
      await next.end().catch(() => {});
      return;
    }
    this.#client = next;
  }

  /** Waits for the connection to end, then reopens it, until closed. */
  async #supervise(): Promise<void> {
    while (!this.#closed) {
      const ended = Promise.withResolvers<void>();
      this.#wake = ended.resolve;
      await ended.promise;
      if (this.#closed) return;
      this.#client = undefined;
      this.#listening.clear();
      const reconnected = Promise.withResolvers<void>();
      this.#ready = reconnected.promise;
      let delay = 500;
      while (!this.#closed) {
        try {
          await this.#connect();
          break;
        } catch (error) {
          log("warn", "listen reconnect failed", errorFields(error));
          // A rotated password: the next attempt uses the new one.
          await this.#credentials.renew(error).catch(() => false);
          await sleep(delay);
          delay = Math.min(delay * 2, 10_000);
        }
      }
      reconnected.resolve();
      if (this.#closed) return;
      for (const subscribers of this.#channels.values())
        for (const subscriber of subscribers) subscriber.onReconnect?.();
    }
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClosed();
    this.#wake?.();
    const client = this.#client;
    this.#client = undefined;
    await client?.end().catch(() => {});
  }
}

/** Listening connections of this process, by database and role. */
const listeners = new Map<string, Listener>();

export async function listen(
  credentials: Credentials,
  channel: string,
  onNotify: (payload: string) => void,
  options: ListenOptions = {},
): Promise<Subscription> {
  if (!CHANNEL.test(channel))
    throw new Error(`invalid channel "${channel}": use [a-z_][a-z0-9_], at most 63 characters`);
  // Two handles on one database (a pool evicted and reopened) bring their own credentials: key by where and as whom.
  const { connectionString, user, host, port, database } = credentials.config;
  const key = connectionString ?? `${user}@${host}:${port}/${database}`;
  let listener = listeners.get(key);
  if (!listener) {
    const created = new Listener(credentials, () => {
      if (listeners.get(key) === created) listeners.delete(key);
    });
    listener = created;
    listeners.set(key, listener);
  }
  return listener.subscribe(channel, {
    onNotify,
    ...(options.onReconnect ? { onReconnect: options.onReconnect } : {}),
  });
}
