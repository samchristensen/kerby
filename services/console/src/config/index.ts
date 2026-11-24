import { loadConfig } from "@kerby/config";
import { z } from "zod";

const consoleConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(0).default(3000),
  /**
   * Kerby's own Postgres, its control database: the `kerby` service's `DATABASE_URL` (the same value). Its role and
   * password do not matter: the console connects as the limited `kerby_console` role, with the password
   * `KERBY_SECRET_KEY` derives.
   */
  databaseUrl: z.string().min(1),
  /**
   * The install's one secret (32 bytes, base64): the `kerby` service's `KERBY_SECRET_KEY`. The console derives from it
   * the `kerby_console` password and the public key model keys are sealed to; it cannot open them.
   */
  kerbySecretKey: z.string().min(1),
  /** The tenant API's address on the private network, where the browser's chat goes: `http://kerby:8080` in Compose. */
  apiUrl: z.url({ protocol: /^https?$/ }),
  /** The tenant API's public address, shown in the quickstart. */
  apiPublicUrl: z.url({ protocol: /^https?$/ }),
  /**
   * The console's own public address, the api's `CONSOLE_PUBLIC_URL` (the same value): it serves Kerby's OAuth Client
   * ID Metadata Document at `<this>/oauth/client-metadata.json`, whose URL is Kerby's client id (ADR 0022). Unset: no
   * document, and the api connects no OAuth server.
   */
  publicUrl: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  /** Mark the session cookie `Secure`. Off only where the console is served over plain HTTP (the local stack). */
  secureCookies: z.stringbool().default(true),
  /**
   * The console sits behind a proxy that writes `X-Forwarded-For` (Railway's edge): the client address is its left-most
   * entry. Off (the default), the socket's address is the client and the header is ignored, since anyone can send it.
   */
  trustProxy: z.stringbool().default(false),
  /** Next.js development mode: compile on request and reload on change. The `dev` image target sets it. */
  devServer: z.stringbool().default(false),
  /** Failed sign-ins one client address may make per minute. */
  failedLoginsPerMinute: z.coerce.number().int().positive().default(10),
  /** Failed sign-ins against one email per hour, from every address together. */
  failedLoginsPerAccountPerHour: z.coerce.number().int().positive().default(20),
});

export type ConsoleConfig = z.output<typeof consoleConfigSchema>;

export const loadConsoleConfig = (): ConsoleConfig => loadConfig(consoleConfigSchema);
