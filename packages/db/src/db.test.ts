import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ClosableControlDb,
  type ClosableTenantDb,
  createClusterAdmin,
  createControlDb,
  createTenantDb,
  LISTEN_APPLICATION_NAME,
  migrate,
  migrateTenants,
  rawPool,
  TENANT_ROLE_CONNECTION_LIMIT,
  type TenantDb,
  TenantPools,
} from "./index.ts";
import { adminUrl, createTestDatabase, type TestDatabase } from "./testing.ts";

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error("condition not reached");
}

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

  it("logs in with the stored password after a rotation, raw pool and LISTEN included", async () => {
    const target = await database();
    const root = createControlDb(adminUrl(), { max: 1 });
    const role = `r_${Math.random().toString(16).slice(2, 10)}`;
    await root.query(`create role ${role} login password 'first'`);
    cleanups.push(async () => {
      await root.query(`drop role if exists ${role}`);
      await root.close();
    });
    let stored = "first";
    let resolved = 0;
    const pools = new TenantPools({
      resolveUrl: async () => {
        resolved++;
        const url = new URL(target.url);
        url.username = role;
        url.password = stored;
        return url.toString();
      },
    });
    cleanups.push(() => pools.close());
    /** Change the role's password as control does, and end its open sessions so the next query must log in. */
    const rotate = async (password: string, store: boolean) => {
      await root.query(`alter role ${role} password '${password}'`);
      if (store) stored = password;
      const { rows } = await root.query<{ pid: number }>(
        "select pid from pg_stat_activity where usename = $1",
        [role],
      );
      const pids = rows.map((row) => row.pid);
      await root.query("select pg_terminate_backend(pid) from unnest($1::int[]) as pid", [pids]);
      await eventually(
        async () =>
          (await root.query("select 1 from pg_stat_activity where pid = any($1::int[])", [pids]))
            .rowCount === 0,
      );
      await sleep(100); // the pool drops the clients the server ended
    };

    const lease = await pools.acquire("t");
    cleanups.push(() => lease.release());
    const reconnected = Promise.withResolvers<void>();
    const subscription = await lease.db.listen("rotated", () => {}, {
      onReconnect: () => reconnected.resolve(),
    });
    cleanups.push(() => subscription.close());
    expect(resolved).toBe(1);

    await rotate("second", true);
    // The same pool and the same lease: the next login asks for the stored password.
    expect((await lease.db.query("select 2 as two")).rows).toEqual([{ two: 2 }]);
    expect(resolved).toBeGreaterThan(1);
    // ...and so does a login through the raw pool, which Absurd uses without Kerby's handle.
    await rotate("third", true);
    expect((await rawPool(lease.db).query("select 4 as four")).rows).toEqual([{ four: 4 }]);
    await reconnected.promise; // the LISTEN connection logged in again with the new password too
    expect((await pools.use("t", (db) => db.query("select 3 as three"))).rows).toEqual([
      { three: 3 },
    ]);

    // A password that is wrong in the store too fails after one retry, with Postgres's error.
    await rotate("fourth", false);
    await expect(lease.db.query("select 1")).rejects.toThrow(/password authentication failed/);
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

describe("ClusterAdmin", () => {
  it("limits a tenant role's connections, also one made before the limit, and changes its password", async () => {
    const root = createControlDb(adminUrl(), { max: 1 });
    const cluster = createClusterAdmin(adminUrl());
    const target = await database();
    const role = `r_${Math.random().toString(16).slice(2, 10)}`;
    cleanups.push(async () => {
      await cluster.dropRole(role);
      await cluster.close();
      await root.close();
    });
    await cluster.createRole(role, "first");
    const limit = async () =>
      (
        await root.query<{ rolconnlimit: number }>(
          "select rolconnlimit from pg_roles where rolname = $1",
          [role],
        )
      ).rows[0]?.rolconnlimit;
    expect(await limit()).toBe(TENANT_ROLE_CONNECTION_LIMIT);
    await root.query(`alter role ${role} connection limit -1`);
    await cluster.limitRoleConnections(role);
    expect(await limit()).toBe(TENANT_ROLE_CONNECTION_LIMIT);

    const as = (password: string) => {
      const url = new URL(target.url);
      url.username = role;
      url.password = password;
      const handle = createTenantDb(url.toString(), { max: 1 });
      cleanups.push(() => handle.close());
      return handle;
    };
    expect((await as("first").query("select 1 as one")).rows).toEqual([{ one: 1 }]);
    await cluster.setRolePassword(role, "it's-second");
    await expect(as("first").query("select 1")).rejects.toThrow(/password authentication failed/);
    expect((await as("it's-second").query("select 2 as two")).rows).toEqual([{ two: 2 }]);
  });
});

describe("listen", () => {
  const listeningConnections = async (name: string): Promise<number> => {
    const admin = createControlDb(adminUrl(), { max: 1 });
    try {
      const { rows } = await admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = $2",
        [name, LISTEN_APPLICATION_NAME],
      );
      return rows[0]?.n ?? 0;
    } finally {
      await admin.close();
    }
  };

  it("delivers notifications, and resyncs after the connection is cut", async () => {
    const database1 = await database();
    const db = await tenantDb(database1);
    const received: string[] = [];
    let reconnects = 0;
    const subscription = await db.listen("things", (payload) => received.push(payload), {
      onReconnect: () => {
        reconnects++;
      },
    });
    cleanups.push(() => subscription.close());

    await db.query("select pg_notify('things', 'one')");
    await eventually(async () => received.length === 1);
    expect(received).toEqual(["one"]);

    // Cut the listener's backend from the server side.
    const admin = createControlDb(adminUrl(), { max: 1 });
    cleanups.push(() => admin.close());
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = $2",
      [database1.name, LISTEN_APPLICATION_NAME],
    );
    await eventually(async () => reconnects === 1);
    await db.query("select pg_notify('things', 'two')");
    await eventually(async () => received.length === 2);
    expect(received).toEqual(["one", "two"]);
  });

  it("shares one connection per database among all subscriptions, and closes it after the last", async () => {
    const database1 = await database();
    // Two handles on the same database (a pool evicted and reopened) still share the listening connection.
    const db = await tenantDb(database1);
    const again = await tenantDb(database1);
    const received = new Map<string, string[]>();
    let reconnects = 0;
    const subscriptions = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 === 0 ? db : again).listen(
          `conversation_${i % 4}`,
          (payload) => received.set(`${i}`, [...(received.get(`${i}`) ?? []), payload]),
          { onReconnect: () => reconnects++ },
        ),
      ),
    );
    cleanups.push(async () => {
      for (const subscription of subscriptions) await subscription.close();
    });
    expect(await listeningConnections(database1.name)).toBe(1);

    // Each subscriber hears its own channel only.
    await db.query("select pg_notify('conversation_1', 'a')");
    await eventually(async () => received.size === 3);
    expect([...received.keys()].sort()).toEqual(["1", "5", "9"]);

    // Every channel is listened again after a reconnect, and every subscriber told to resync.
    const admin = createControlDb(adminUrl(), { max: 1 });
    cleanups.push(() => admin.close());
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and application_name = $2",
      [database1.name, LISTEN_APPLICATION_NAME],
    );
    await eventually(async () => reconnects === 12);
    await db.query("select pg_notify('conversation_2', 'b')");
    await eventually(async () => received.size === 6);

    // A channel whose subscribers all left is unlistened; the others keep hearing.
    for (const i of [3, 7, 11]) await subscriptions[i]?.close();
    await db.query("select pg_notify('conversation_3', 'c'), pg_notify('conversation_0', 'd')");
    await eventually(async () => received.get("0")?.length === 1);
    expect(received.has("3")).toBe(false);
    expect(await listeningConnections(database1.name)).toBe(1);

    for (const subscription of subscriptions) await subscription?.close();
    await eventually(async () => (await listeningConnections(database1.name)) === 0);
    // A new subscriber after that opens a fresh connection.
    const late = await db.listen("conversation_0", () => {});
    expect(await listeningConnections(database1.name)).toBe(1);
    await late.close();
  });

  it("stops delivering after close and rejects an unsafe channel name", async () => {
    const db = await tenantDb(await database());
    await expect(db.listen('x"; drop table y; --', () => {})).rejects.toThrow(/invalid channel/);
    const received: string[] = [];
    const subscription = await db.listen("quiet", (payload) => received.push(payload));
    await subscription.close();
    await db.query("select pg_notify('quiet', 'late')");
    await sleep(200);
    expect(received).toEqual([]);
  });
});
