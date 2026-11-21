// The tenant schema: conversations and messages, plus the order every tenant database is migrated in (ADR 0006).
import { join } from "node:path";
import { blobsMigrationsDir } from "@kerby/blobs";
import { durableMigrationsDir } from "@kerby/durable";

export const conversationsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

/** Every tenant database's migrations, in apply order: Absurd and queues, the blob index, then conversations. */
export const tenantMigrationDirs: readonly string[] = [
  durableMigrationsDir,
  blobsMigrationsDir,
  conversationsMigrationsDir,
];
