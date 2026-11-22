// Test helpers: real databases on the disposable Postgres from scripts/test-containers.ts.
// Higher-level helpers (`createTestControlDb`, `createTestTenant`) live in the packages that own the schema.
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { createControlDb, migrate } from "./index.ts";

export type TestDatabase = {
  name: string;
  /** Superuser URL of this database. */
  url: string;
  drop(): Promise<void>;
};

/** Superuser URL of the test Postgres server (database `postgres`). */
export function adminUrl(): string {
  return inject("containers").postgresUrl;
}

function urlForDatabase(name: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/** Run one statement on the server's maintenance database. */
async function admin(sql: string): Promise<void> {
  const db = createControlDb(adminUrl(), { max: 1 });
  try {
    await db.query(sql);
  } finally {
    await db.close();
  }
}

/** A new empty database, or a copy of `template` (which must have no open connections). */
export async function createTestDatabase(template?: string): Promise<TestDatabase> {
  const name = `kt_${randomBytes(6).toString("hex")}`;
  await admin(`create database ${name}${template ? ` template ${template}` : ""}`);
  return {
    name,
    url: urlForDatabase(name),
    drop: () => admin(`drop database if exists ${name} with (force)`),
  };
}

// One migrated template per distinct set of migration directories per test process; each caller copies it
// (about 22 ms, plan 0001 S4) instead of migrating from scratch.
const templates = new Map<string, Promise<TestDatabase>>();

/** A fresh database holding `dirs`' migrations. Pass the same `dirs` in the same order to share a template. */
export async function createMigratedDatabase(dirs: readonly string[]): Promise<TestDatabase> {
  const key = dirs.join("\n");
  let template = templates.get(key);
  if (!template) {
    template = (async () => {
      const db = await createTestDatabase();
      const handle = createControlDb(db.url, { max: 1 });
      try {
        await migrate(handle, dirs);
      } finally {
        await handle.close();
      }
      return db;
    })();
    templates.set(key, template);
  }
  return createTestDatabase((await template).name);
}
