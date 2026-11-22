// Who a handle connects as. A tenant role's password can be rotated while pools are open (ADR 0009): Postgres checks a
// password only at login, so open sessions keep working and only new logins need the new one. A handle given a
// `refreshUrl` therefore looks the password up for every login after its first, through pg's password callback, which
// also covers the raw pool Absurd holds for the length of a turn. A login refused with 28P01 (a rotation committing
// at that moment) is retried once.
import { setTimeout as sleep } from "node:timers/promises";
import { errorCode } from "@kerby/observability";
import type pg from "pg";

/** Postgres: invalid_password. */
const INVALID_PASSWORD = "28P01";
/** Long enough for a rotation's `alter role` and its stored row to both commit. */
const RETRY_AFTER_MS = 250;

export type Credentials = {
  /** For `new pg.Pool` / `new pg.Client`. */
  readonly config: pg.ClientConfig;
  /** After a failed connect: whether Postgres refused the password and one more login may now succeed. */
  renew(error: unknown): Promise<boolean>;
};

export function credentialsFor(url: string, refreshUrl?: () => Promise<string>): Credentials {
  if (!refreshUrl) return { config: { connectionString: url }, renew: async () => false };
  const target = new URL(url);
  // The caller just resolved `url`: its password serves the first login.
  let fresh: string | undefined = decodeURIComponent(target.password);
  const sslmode = target.searchParams.get("sslmode");
  return {
    // Fields, not a connection string: pg lets a connection string's password (empty here) replace a password function.
    config: {
      host: target.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: Number(target.port || 5432),
      database: decodeURIComponent(target.pathname.slice(1)),
      user: decodeURIComponent(target.username),
      password: async () => {
        if (fresh !== undefined) {
          const password = fresh;
          fresh = undefined;
          return password;
        }
        return decodeURIComponent(new URL(await refreshUrl()).password);
      },
      // What pg makes of `sslmode` in a URL today: anything but `disable` is TLS that verifies the server.
      ...(sslmode !== null && sslmode !== "disable" ? { ssl: {} } : {}),
    },
    async renew(error) {
      if (errorCode(error) !== INVALID_PASSWORD) return false;
      fresh = undefined;
      await sleep(RETRY_AFTER_MS);
      return true;
    },
  };
}
