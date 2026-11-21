import { expect, it } from "vitest";
import { createTestControlDb } from "./testing.ts";

it("the control migrations create the control tables, and keys belong to a tenant", async () => {
  await using control = await createTestControlDb();
  const { rows } = await control.db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
  );
  expect(rows.map((r) => r.table_name)).toEqual([
    "api_keys",
    "audit_log",
    "schema_migrations",
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
