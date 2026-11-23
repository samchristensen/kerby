import { type ClosableControlDb, createControlDb } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { controlMigrationsDir, setRolePassword } from "./index.ts";

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

/**
 * A handle on the control database at `controlUrl` as one of the limited service roles, given a password the way
 * control does. Roles are cluster-wide and test files run in parallel on one cluster: every caller sets the same
 * password per role, so one file's login never fails because another just changed it.
 */
export async function asServiceRole(
  controlUrl: string,
  role: "kerby_app" | "kerby_console",
  max = 1,
): Promise<ClosableControlDb> {
  const password = `${role}-password-for-tests`;
  const admin = createControlDb(controlUrl, { max: 1 });
  try {
    await setRolePassword(admin, role, password);
  } finally {
    await admin.close();
  }
  const url = new URL(controlUrl);
  url.username = role;
  url.password = password;
  return createControlDb(url.toString(), { max });
}
