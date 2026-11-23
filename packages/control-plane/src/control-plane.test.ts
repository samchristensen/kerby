import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlDb, migrate } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { expect, it } from "vitest";
import { controlMigrationsDir, insertConsoleUser, insertTenant, isSignupAllowed } from "./index.ts";
import { createTestControlDb } from "./testing.ts";

it("the control migrations create the control tables, and keys belong to a tenant", async () => {
  await using control = await createTestControlDb();
  const { rows } = await control.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  expect(rows.map((r) => r.table_name)).toEqual([
    "api_keys",
    "audit_log",
    "console_sessions",
    "console_users",
    "schema_migrations",
    "signup_allowlist",
    "tenant_db_credentials",
    "tenant_secrets",
    "tenants",
    "usage",
  ]);
  await expect(
    control.db.query(
      "insert into api_keys (id, tenant_id, key_hash) values ('k1', gen_random_uuid(), '\\x00')",
    ),
  ).rejects.toThrow(/foreign key/);
});

it("gives each test its own database", async () => {
  await using a = await createTestControlDb();
  await using b = await createTestControlDb();
  await a.db.query(
    "insert into tenants (name, db_host, db_port, db_name, db_role) values ('a', 'h', 1, 'd', 'r')",
  );
  expect((await b.db.query("select 1 from tenants")).rowCount).toBe(0);
});

it("migration 0007 keeps everyone who already had an account allowed to sign up, and no one else", async () => {
  const root = mkdtempSync(join(tmpdir(), "kerby-control-migrations-"));
  // The shape the migration loader accepts, named as it names the real ones: <workspace>/migrations/control.
  const before = join(root, "control-plane", "migrations", "control");
  try {
    mkdirSync(before, { recursive: true });
    for (const name of readdirSync(controlMigrationsDir)) {
      if (name < "0007") copyFileSync(join(controlMigrationsDir, name), join(before, name));
    }
    const database = await createMigratedDatabase([before]);
    const db = createControlDb(database.url, { max: 1 });
    try {
      const tenant = await insertTenant(db, { name: "acme", dbHost: "h", dbPort: 1 });
      await insertConsoleUser(db, {
        tenantId: tenant.id,
        email: "ada@example.com",
        passwordHash: "x",
      });
      await migrate(db, [controlMigrationsDir]);
      expect(await isSignupAllowed(db, "ada@example.com")).toBe(true);
      expect(await isSignupAllowed(db, "grace@example.com")).toBe(false);
    } finally {
      await db.close();
      await database.drop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
