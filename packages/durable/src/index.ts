import { join } from "node:path";

export { cleanup } from "./cleanup.ts";
export {
  createTenantExecutor,
  holdsRun,
  type RunContext,
  type TaskHandlers,
} from "./executor.ts";
export { readTask } from "./read.ts";
export { spawnInTx } from "./spawn.ts";
export type { Queue, TaskParams } from "./tasks.ts";

/** Absurd's schema and Kerby's queues: tenant migrations, applied first. */
export const durableMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");
