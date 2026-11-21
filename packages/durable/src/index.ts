import { join } from "node:path";

export { cleanup } from "./cleanup.ts";
export {
  type ClaimedRun,
  createTenantExecutor,
  type ExecutorOptions,
  holdsRun,
  type RunContext,
  type TaskHandlers,
  type TenantExecutor,
} from "./executor.ts";
export { type Spawned, type SpawnOptions, spawnInTx } from "./spawn.ts";
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY,
  QUEUES,
  type Queue,
  TASKS,
  type TaskName,
  type TaskParams,
  taskNames,
} from "./tasks.ts";

/** Absurd's schema and Kerby's queues: tenant migrations, applied first. */
export const durableMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");
