import { loadConfig } from "@kerby/config";
import { z } from "zod";

const consoleConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(3000),
  /** The control database, as the limited `kerby_console` role control makes (migration 0005). */
  controlDatabaseUrl: z.string().min(1),
  /** Control's address on the private network, for sign-up: `http://control:8081` locally. */
  controlUrl: z.url({ protocol: /^https?$/ }),
  /** The token control accepts on its sign-up route, and nowhere else (control's `CONSOLE_TOKEN`). */
  consoleToken: z.string().min(16),
  /** Public key model keys are sealed to (base64): the api's `SECRETS_PUBLIC_KEY`. The console cannot open them. */
  secretsPublicKey: z.string().min(1),
  /** The tenant API's address on the private network, where the browser's chat goes: `http://api:8080` locally. */
  apiUrl: z.url({ protocol: /^https?$/ }),
  /** The tenant API's public address, shown in the quickstart. */
  apiPublicUrl: z.url({ protocol: /^https?$/ }),
  /** Mark the session cookie `Secure`. Off only where the console is served over plain HTTP (the local stack). */
  secureCookies: z.stringbool().default(true),
  /**
   * The console sits behind a proxy that writes `X-Forwarded-For` (Railway's edge): the client address is its left-most
   * entry. Off (the default), the socket's address is the client and the header is ignored, since anyone can send it.
   */
  trustProxy: z.stringbool().default(false),
  /** Next.js development mode: compile on request and reload on change. The `dev` image target sets it. */
  devServer: z.stringbool().default(false),
  /** Sign-ups one client address may make per hour: each provisions a database. */
  signupsPerHour: z.coerce.number().int().positive().default(5),
  /** Failed sign-ins one client address may make per minute. */
  failedLoginsPerMinute: z.coerce.number().int().positive().default(10),
  /** Failed sign-ins against one email per hour, from every address together. */
  failedLoginsPerAccountPerHour: z.coerce.number().int().positive().default(20),
});

export type ConsoleConfig = z.output<typeof consoleConfigSchema>;

export const loadConsoleConfig = (): ConsoleConfig => loadConfig(consoleConfigSchema);
