import type { ConsoleDeps, ConsoleService } from "../types/index.ts";
import { createAccounts } from "./accounts.ts";
import { createChats } from "./chats.ts";
import { createIntegrations } from "./integrations.ts";
import { createSearch } from "./search.ts";
import { createStudio } from "./studio.ts";
import { createSubscriptions } from "./subscriptions.ts";
import { createTools } from "./tools.ts";
import { createWorkspace } from "./workspace.ts";

/** The console's operations bound to `deps`: what `src/index.ts` installs for the pages. */
export function createConsoleService(deps: ConsoleDeps): ConsoleService {
  return {
    ...createAccounts(deps),
    ...createWorkspace(deps),
    ...createIntegrations(deps),
    ...createSubscriptions(deps),
    ...createChats(deps),
    ...createSearch(deps),
    ...createStudio(deps),
    ...createTools(deps),
  };
}
