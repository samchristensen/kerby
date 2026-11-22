// LISTEN/NOTIFY over a dedicated connection (a pooled one would be held for the stream's whole life). A lost
// connection is re-opened with backoff; `onReconnect` tells the caller to resync, since notifications sent while
// disconnected are gone (the callers keep a periodic poll as the backstop).
import { setTimeout as sleep } from "node:timers/promises";
import { errorFields, log } from "@kerby/observability";
import pg from "pg";
import { withConnectRetry } from "./connect-retry.ts";
import type { Credentials } from "./credentials.ts";

export type Subscription = { close(): Promise<void> };
export type ListenOptions = { onReconnect?: () => void };

const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

export async function listen(
  credentials: Credentials,
  channel: string,
  onNotify: (payload: string) => void,
  options: ListenOptions = {},
): Promise<Subscription> {
  if (!CHANNEL.test(channel))
    throw new Error(`invalid channel "${channel}": use [a-z_][a-z0-9_], at most 63 characters`);
  let closed = false;
  let client: pg.Client | undefined;
  let wake: (() => void) | undefined;

  async function connect(): Promise<void> {
    const next = new pg.Client(credentials.config);
    next.on("notification", (message) => {
      if (!closed) onNotify(message.payload ?? "");
    });
    // `end` also fires after a deliberate close: only an unexpected end triggers a reconnect.
    next.on("error", (error) => log("warn", "listen connection error", errorFields(error)));
    next.on("end", () => {
      if (!closed && client === next) wake?.();
    });
    await next.connect();
    await next.query(`listen "${channel}"`);
    client = next;
  }

  try {
    await withConnectRetry(connect);
  } catch (error) {
    if (!(await credentials.renew(error))) throw error;
    await withConnectRetry(connect);
  }

  // Supervisor: waits for the connection to end, then reopens it.
  void (async () => {
    while (!closed) {
      const { promise, resolve } = Promise.withResolvers<void>();
      wake = resolve;
      await promise;
      let delay = 500;
      while (!closed) {
        try {
          await connect();
          options.onReconnect?.();
          break;
        } catch (error) {
          log("warn", "listen reconnect failed", errorFields(error));
          // A rotated password: the next attempt uses the new one.
          await credentials.renew(error).catch(() => false);
          await sleep(delay);
          delay = Math.min(delay * 2, 10_000);
        }
      }
    }
  })();

  return {
    async close() {
      closed = true;
      wake?.();
      const current = client;
      client = undefined;
      await current?.end().catch(() => {});
    },
  };
}
