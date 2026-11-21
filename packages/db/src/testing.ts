// Test helpers: real databases on the disposable Postgres from scripts/test-containers.ts.
// Higher-level helpers (`createTestControlDb`, `createTestTenant`) live in the packages that own the schema.
import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { createControlDb } from "./index.ts";

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

export function urlForDatabase(name: string): string {
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
