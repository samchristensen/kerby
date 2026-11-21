import { type ClosableTenantDb, createTenantDb, type TenantContext } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { tenantMigrationDirs } from "./index.ts";

export type TestTenant = TenantContext & { db: ClosableTenantDb; url: string } & AsyncDisposable;

/** A tenant with its own fresh, fully migrated database and a unique id (so a unique object prefix). */
export async function createTestTenant(): Promise<TestTenant> {
  const database = await createMigratedDatabase(tenantMigrationDirs);
  const db = createTenantDb(database.url, { max: 5 });
  return {
    tenantId: crypto.randomUUID(),
    db,
    url: database.url,
    async [Symbol.asyncDispose]() {
      await db.close();
      await database.drop();
    },
  };
}
