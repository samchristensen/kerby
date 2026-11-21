import { type ClosableControlDb, createControlDb, migrate } from "@kerby/db";
import { createTestDatabase, type TestDatabase } from "@kerby/db/testing";
import { controlMigrationsDir } from "./index.ts";

// One migrated template per test process; each test copies it (tens of milliseconds).
let template: Promise<TestDatabase> | undefined;
function controlTemplate(): Promise<TestDatabase> {
  template ??= (async () => {
    const db = await createTestDatabase();
    const handle = createControlDb(db.url, { max: 1 });
    try {
      await migrate(handle, [controlMigrationsDir]);
    } finally {
      await handle.close();
    }
    return db;
  })();
  return template;
}

export type TestControlDb = { db: ClosableControlDb; url: string } & AsyncDisposable;

/** A fresh control database with the control migrations applied. Use with `await using`. */
export async function createTestControlDb(): Promise<TestControlDb> {
  const database = await createTestDatabase((await controlTemplate()).name);
  const db = createControlDb(database.url, { max: 5 });
  return {
    db,
    url: database.url,
    async [Symbol.asyncDispose]() {
      await db.close();
      await database.drop();
    },
  };
}
