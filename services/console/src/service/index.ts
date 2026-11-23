import type { ConsoleDeps, ConsoleService } from "../types/index.ts";
import { createAccounts } from "./accounts.ts";
import { createAdmin } from "./admin.ts";
import { createChats } from "./chats.ts";
import { createStudio } from "./studio.ts";
import { createWorkspace } from "./workspace.ts";

/** The console's operations bound to `deps`: what `src/index.ts` installs for the pages. */
export function createConsoleService(deps: ConsoleDeps): ConsoleService {
  return {
    ...createAccounts(deps),
    ...createAdmin(deps),
    ...createWorkspace(deps),
    ...createChats(deps),
    ...createStudio(deps),
  };
}
