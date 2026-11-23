import type { ConsoleDeps, ConsoleService } from "../types/index.ts";
import { createAccounts } from "./accounts.ts";
import { createWorkspace } from "./workspace.ts";

/** The console's operations bound to `deps`: what `src/index.ts` installs for the pages. */
export function createConsoleService(deps: ConsoleDeps): ConsoleService {
  return { ...createAccounts(deps), ...createWorkspace(deps) };
}
