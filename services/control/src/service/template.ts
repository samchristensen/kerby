import { tenantMigrationDirs } from "@kerby/conversations";
import { createTenantDb, migrate } from "@kerby/db";
import type { ControlDeps } from "../types/index.ts";

/**
 * The template tenant databases are copied from (plan 0001, S4: 22 ms per copy). Created if absent, then brought up
 * to the current tenant migrations. A stale template is harmless: provisioning migrates each copy afterwards.
 */
export async function ensureTemplate(deps: ControlDeps): Promise<string[]> {
  const { cluster, settings } = deps;
  if (!(await cluster.databaseExists(settings.templateDatabase))) {
    await cluster.createDatabase(settings.templateDatabase);
  }
  const handle = createTenantDb(cluster.urlFor(settings.templateDatabase), { max: 1 });
  try {
    return await migrate(handle, tenantMigrationDirs);
  } finally {
    // A template must have no sessions left when it is copied.
    await handle.close();
  }
}

/**
 * Close the maintenance databases and the template to everyone but the admin role. A tenant role has no grants there,
 * but `public` may connect by default, and a session held in the template makes provisioning fail (`55006`).
 * Idempotent; run at startup after `ensureTemplate`.
 */
export async function restrictClusterDatabases(deps: ControlDeps): Promise<void> {
  const { cluster, settings } = deps;
  for (const database of ["postgres", "template1", settings.templateDatabase]) {
    if (await cluster.databaseExists(database)) await cluster.restrictToAdmin(database);
  }
}
