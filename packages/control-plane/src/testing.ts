import { type ClosableControlDb, createControlDb } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { controlMigrationsDir } from "./index.ts";

export type TestControlDb = { db: ClosableControlDb; url: string } & AsyncDisposable;

/** A fresh control database with the control migrations applied. Use with `await using`. */
export async function createTestControlDb(): Promise<TestControlDb> {
  const database = await createMigratedDatabase([controlMigrationsDir]);
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
