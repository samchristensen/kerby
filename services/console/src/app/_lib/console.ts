// The bridge between the console's two halves (ADR 0014). `src/index.ts` builds the service natively and installs it
// here before Next.js starts; pages and actions, which Next.js bundles, read it back. This file imports types only, so
// its two copies (the native one and the bundled one) share one global and never hold two services.
import type { ConsoleService } from "../../types/index.ts";

type Installed = { service: ConsoleService; secureCookies: boolean };

declare global {
  // A `var` is how a global is declared; it holds the one installed console of this process.
  var kerbyConsole: Installed | undefined;
}

/** Set by the console's server (src/runtime/server.ts) on every request; a value a client sends is replaced. */
export const CLIENT_ADDRESS_HEADER = "x-kerby-client-address";

export function installConsole(installed: Installed): void {
  globalThis.kerbyConsole = installed;
}

function installed(): Installed {
  const found = globalThis.kerbyConsole;
  if (!found) {
    throw new Error(
      "the console service is not installed: start the console with `node services/console/src/index.ts`, not `next start`",
    );
  }
  return found;
}

export const consoleService = (): ConsoleService => installed().service;

/** Whether the session cookie is `Secure`: off only where the console is served over plain HTTP (locally). */
export const secureCookies = (): boolean => installed().secureCookies;
