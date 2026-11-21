import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ClosableControlDb,
  type ClosableTenantDb,
  createControlDb,
  createTenantDb,
  migrate,
  migrateTenants,
  type TenantDb,
  TenantPools,
} from "./index.ts";
import { adminUrl, createTestDatabase, type TestDatabase } from "./testing.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(template?: string): Promise<TestDatabase> {
  const db = await createTestDatabase(template);
  cleanups.push(() => db.drop());
  return db;
}
async function tenantDb(db: TestDatabase): Promise<ClosableTenantDb> {
  const handle = createTenantDb(db.url);
  cleanups.push(() => handle.close());
  return handle;
}

/** A `<workspace>/migrations/tenant` directory holding the given files. */
function migrationsDir(files: Record<string, string>, workspace = "demo"): string {
  const root = mkdtempSync(join(tmpdir(), "kerby-mig-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, workspace, "migrations", "tenant");
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("handles", () => {
  it("a TenantDb reaches only its own database", async () => {
    const a = await tenantDb(await database());
    const b = await tenantDb(await database());
    await a.query("create table secrets_of_a (v int)");
    await a.query("insert into secrets_of_a values (1)");
    expect((await a.query("select v from secrets_of_a")).rows).toEqual([{ v: 1 }]);
    await expect(b.query("select v from secrets_of_a")).rejects.toThrow(/does not exist/);
  });

  it("does not accept a ControlDb where a TenantDb is required", async () => {
    const control: ClosableControlDb = createControlDb((await database()).url);
    cleanups.push(() => control.close());
    const needsTenant = async (db: TenantDb) => (await db.query("select 1 as one")).rows;
    // @ts-expect-error a control-plane handle is not a tenant handle
    await needsTenant(control);
    const tenant: TenantDb = await tenantDb(await database());
    const needsControl = async (db: ClosableControlDb) => (await db.query("select 1 as one")).rows;
    // @ts-expect-error a tenant handle is not a control-plane handle
    await needsControl(tenant);
  });

  it("commits a transaction and rolls it back on error", async () => {
    const db = await tenantDb(await database());
    await db.query("create table t (v int)");
    await db.transaction(async (tx) => {
      await tx.query("insert into t values (1)");
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into t values (2)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query("select v from t order by v")).rows).toEqual([{ v: 1 }]);
  });

  it("survives a statement error inside a transaction without leaking the connection", async () => {
    const db = createTenantDb((await database()).url, { max: 1 });
    cleanups.push(() => db.close());
    for (let i = 0; i < 3; i++) {
      await expect(db.transaction((tx) => tx.query("select * from missing"))).rejects.toThrow();
    }
    expect((await db.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
  });
});

describe("migrate", () => {
  it("applies each file once, in name order, and records it under the workspace name", async () => {
    const db = await tenantDb(await database());
    const dir = migrationsDir({
      "0002_b.sql": "insert into log values ('b');",
      "0001_a.sql": "create table log (v text); insert into log values ('a');",
    });
    expect(await migrate(db, [dir])).toEqual(["demo/0001_a.sql", "demo/0002_b.sql"]);
    expect(await migrate(db, [dir])).toEqual([]);
    expect((await db.query("select v from log")).rows).toEqual([{ v: "a" }, { v: "b" }]);
  });

  it("rolls everything back when one file fails, and names it", async () => {
    const db = await tenantDb(await database());
    const dir = migrationsDir({
      "0001_ok.sql": "create table ok (v int);",
      "0002_bad.sql": "select * from nowhere;",
    });
    await expect(migrate(db, [dir])).rejects.toThrow(/demo\/0002_bad\.sql failed/);
    await expect(db.query("select * from ok")).rejects.toThrow(/does not exist/);
  });

  it("serializes concurrent migrators", async () => {
    const database1 = await database();
    const first = await tenantDb(database1);
    const second = await tenantDb(database1);
    const dir = migrationsDir({ "0001_a.sql": "create table once (v int);" });
    const results = await Promise.all([migrate(first, [dir]), migrate(second, [dir])]);
    expect(results.flat()).toEqual(["demo/0001_a.sql"]);
  });

  it("rejects a directory outside <workspace>/migrations", async () => {
    const db = await tenantDb(await database());
    await expect(migrate(db, [tmpdir()])).rejects.toThrow(
      /migrations\/control\/ or migrations\/tenant/,
    );
  });
});

describe("TenantPools", () => {
  /** Backends connected to a database other than ours, from the admin connection. */
  async function connections(name: string): Promise<number> {
    const admin = createControlDb(adminUrl(), { max: 1 });
    try {
      const { rows } = await admin.query<{ n: string }>(
        "select count(*)::text as n from pg_stat_activity where datname = $1",
        [name],
      );
      return Number(rows[0]?.n);
    } finally {
      await admin.close();
    }
  }
  async function eventually(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error("condition not reached");
  }

  async function threeTenants() {
    const dbs = await Promise.all([database(), database(), database()]);
    const urls = new Map<string, string>(dbs.map((db, i) => [`t${i}`, db.url]));
    const names = new Map<string, string>(dbs.map((db, i) => [`t${i}`, db.name]));
    const pools = new TenantPools({
      resolveUrl: async (id) => urls.get(id) ?? Promise.reject(new Error(`unknown tenant ${id}`)),
      maxPools: 2,
    });
    cleanups.push(() => pools.close());
    return { pools, names };
  }

  it("evicts the least recently used idle pool and closes its connections", async () => {
    const { pools, names } = await threeTenants();
    for (const id of ["t0", "t1", "t2"]) await pools.use(id, (db) => db.query("select 1"));
    expect(pools.size).toBe(2);
    await eventually(async () => (await connections(names.get("t0") ?? "")) === 0);
    expect(await connections(names.get("t2") ?? "")).toBeGreaterThan(0);
  });

  it("never evicts a pool that is leased", async () => {
    const { pools } = await threeTenants();
    const release = Promise.withResolvers<void>();
    const held = pools.use("t0", async (db) => {
      await db.query("select 1");
      await release.promise;
      return (await db.query("select 2 as two")).rows;
    });
    await sleep(100);
    for (const id of ["t1", "t2"]) await pools.use(id, (db) => db.query("select 1"));
    release.resolve();
    expect(await held).toEqual([{ two: 2 }]);
  });

  it("evict() lets a running use finish, then closes", async () => {
    const { pools, names } = await threeTenants();
    const release = Promise.withResolvers<void>();
    const held = pools.use("t0", async (db) => {
      await db.query("select 1");
      await release.promise;
      return (await db.query("select 3 as three")).rows;
    });
    await sleep(100);
    await pools.evict("t0");
    release.resolve();
    expect(await held).toEqual([{ three: 3 }]);
    await eventually(async () => (await connections(names.get("t0") ?? "")) === 0);
  });

  it("does not remember a failed open", async () => {
    const dbs = await database();
    let fail = true;
    const pools = new TenantPools({
      resolveUrl: async () => {
        if (fail) throw new Error("resolver down");
        return dbs.url;
      },
    });
    cleanups.push(() => pools.close());
    await expect(pools.use("a", (db) => db.query("select 1"))).rejects.toThrow("resolver down");
    fail = false;
    expect((await pools.use("a", (db) => db.query("select 1 as one"))).rows).toEqual([{ one: 1 }]);
  });

  it("fans a migration out to every tenant and reports the ones that fail", async () => {
    const dbs = await Promise.all([database(), database()]);
    const urls = new Map([
      ["ok1", dbs[0]?.url ?? ""],
      ["ok2", dbs[1]?.url ?? ""],
    ]);
    const pools = new TenantPools({
      resolveUrl: async (id) => urls.get(id) ?? Promise.reject(new Error("no such tenant")),
    });
    cleanups.push(() => pools.close());
    const dir = migrationsDir({ "0001_a.sql": "create table fanned (v int);" });
    const result = await migrateTenants(pools, ["ok1", "gone", "ok2"], [dir], { concurrency: 2 });
    expect(result.migrated.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed.map((f) => f.tenantId)).toEqual(["gone"]);
    for (const id of ["ok1", "ok2"]) {
      expect(
        (await pools.use(id, (db) => db.query("select count(*)::int as n from fanned"))).rows,
      ).toEqual([{ n: 0 }]);
    }
  });
});
