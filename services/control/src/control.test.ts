import { randomBytes } from "node:crypto";
import { tenantPrefix } from "@kerby/blobs";
import { createTestBlobs, createTestBucket } from "@kerby/blobs/testing";
import { SCOPES } from "@kerby/contracts";
import {
  authenticateApiKey,
  createApiKey,
  createConsoleSession,
  createIntegration,
  findConsoleUser,
  getTenant,
  hintTenantWork,
  insertSubscription,
  insertTenant,
  listIntegrations,
  listTenants,
  newApiKey,
  readConsoleSession,
  readTenantDbPassword,
  resolveTenantDbUrl,
  revokeApiKey,
  setTenantStatus,
  verifyPassword,
} from "@kerby/control-plane";
import { createTestControlDb, type TestControlDb } from "@kerby/control-plane/testing";
import { insertConversation, tenantMigrationDirs } from "@kerby/conversations";
import {
  type ClusterAdmin,
  createClusterAdmin,
  createControlDb,
  createTenantDb,
  readMigrations,
  TenantPools,
} from "@kerby/db";
import { adminUrl } from "@kerby/db/testing";
import { recordDeliveryAttempt } from "@kerby/events";
import { configureLogging } from "@kerby/observability";
import {
  createSealer,
  createSecretBox,
  generateBoxKey,
  generateSecretsKeyPair,
} from "@kerby/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { untilNext } from "./runtime/nightly.ts";
import { ensureTenantDbPasswords } from "./service/db-credentials.ts";
import { bootstrapInstance, type InstanceSettings } from "./service/instance.ts";
import { migrateAllTenants } from "./service/migrate.ts";
import { pruneTenants } from "./service/retention.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import { deleteTenant, provisionTenant } from "./service/tenants.ts";
import type { ControlDeps } from "./types/index.ts";

/** TENANT_DB_KEYS for every test: one box, as one install has. */
const tenantDbBox = createSecretBox([generateBoxKey()]);
/** A cheap scrypt for tests; production uses `PASSWORD_COST`. */
const COST = 10;
const PASSWORD = "correct horse battery";
const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The log lines written from here to the end of the test, parsed. */
function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  configureLogging({ write: (line) => lines.push(JSON.parse(line)) });
  cleanups.push(() => configureLogging({ write: (line) => process.stdout.write(line) }));
  return lines;
}

async function start(wrap?: (cluster: ClusterAdmin) => ClusterAdmin) {
  const control: TestControlDb = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const realCluster = createClusterAdmin(adminUrl());
  cleanups.push(() => realCluster.close());
  const cluster = wrap ? wrap(realCluster) : realCluster;
  const blobs = await createTestBlobs();
  const bucket = await createTestBucket();
  /** The tenant's database URL as its own role, with the password control stored for it. */
  const tenantUrl = (tenantId: string) => resolveTenantDbUrl(control.db, tenantDbBox, tenantId);
  const pools = new TenantPools({ resolveUrl: tenantUrl });
  cleanups.push(() => pools.close());
  const adminHost = new URL(adminUrl());
  const templateDatabase = `kt_tpl_${randomBytes(4).toString("hex")}`;
  const deps: ControlDeps = {
    control: control.db,
    cluster,
    bucket,
    pools,
    tenantDbBox,
    settings: {
      clusterHost: adminHost.hostname,
      clusterPort: Number(adminHost.port),
      templateDatabase,
    },
  };
  await ensureTemplate(deps);
  await restrictClusterDatabases(deps);
  cleanups.push(() => realCluster.dropDatabase(templateDatabase));
  /** Provision a tenant, and drop its database and role after the test. */
  const provision = async (name: string) => {
    const { tenant } = await provisionTenant(deps, { name });
    cleanups.push(() => deleteTenant(deps, tenant.id));
    return tenant;
  };
  const tenantDb = async (tenantId: string) => {
    const db = createTenantDb(await tenantUrl(tenantId));
    cleanups.push(() => db.close());
    return { tenantId, db };
  };
  return { control, cluster: realCluster, blobs, bucket, deps, provision, tenantDb, tenantUrl };
}

describe("provisioning", () => {
  it("creates a migrated database owned by a role that can reach only it, and a default integration with every scope", async () => {
    const { provision, cluster, control, tenantUrl } = await start();
    const created = await provision("acme");
    const tenant = (await getTenant(control.db, created.id)) ?? expect.fail("no tenant row");

    expect(created.status).toBe("active");
    expect(created.schemaVersion).toBe(readMigrations(tenantMigrationDirs).at(-1)?.name);
    expect(await cluster.databaseExists(tenant.dbName)).toBe(true);
    expect(await cluster.roleExists(tenant.dbRole)).toBe(true);
    const integrations = await listIntegrations(control.db, tenant.id);
    expect(integrations.map((i) => ({ name: i.name, scopes: [...i.scopes].sort() }))).toEqual([
      { name: "default", scopes: [...SCOPES].sort() },
    ]);

    const own = createTenantDb(await tenantUrl(tenant.id));
    cleanups.push(() => own.close());
    const owners = await own.query<{ tableowner: string }>(
      "select distinct tableowner from pg_tables where tablename in ('conversations', 'messages', 'blobs', 'search_chunks')",
    );
    expect(owners.rows).toEqual([{ tableowner: tenant.dbRole }]);
    // The template's `vector` came along; the role can use it though the extension stays the admin's.
    expect(
      (await own.query("select '[1,0]'::halfvec <=> '[0,1]'::halfvec as distance")).rows,
    ).toEqual([{ distance: 1 }]);
    await own.query("insert into conversations (model) values ('m')"); // the role can use its schema

    // A second tenant's role cannot connect to the first tenant's database: the seam a SaaS return relies on.
    const other = await provision("globex");
    const crossUrl = new URL(await tenantUrl(other.id));
    crossUrl.pathname = `/${tenant.dbName}`;
    const intruder = createTenantDb(crossUrl.toString(), { max: 1 });
    cleanups.push(() => intruder.close());
    await expect(intruder.query("select 1")).rejects.toThrow(/permission denied|not allowed/);
  });

  it("refuses a tenant role on the maintenance databases and the template, and still provisions from it", async () => {
    const { provision, cluster, deps, tenantUrl } = await start();
    const tenant = await provision("acme");
    // Over the network address with the role's own password, as an intruder would try.
    for (const database of ["postgres", "template1", deps.settings.templateDatabase]) {
      const url = new URL(await tenantUrl(tenant.id));
      url.pathname = `/${database}`;
      const intruder = createTenantDb(url.toString(), { max: 1 });
      cleanups.push(() => intruder.close());
      await expect(intruder.query("select 1"), database).rejects.toThrow(
        `permission denied for database "${database}"`,
      );
    }
    // Copying the closed template works, and so does the admin URL, which connects to `postgres`.
    const other = await provision("globex");
    expect(await cluster.databaseExists(other.dbName)).toBe(true);
  });

  it("leaves nothing behind when provisioning fails halfway", async () => {
    let created: { role?: string | undefined; database?: string | undefined } = {};
    const { deps, control, cluster } = await start((real) => ({
      ...real,
      createDatabase: async (name, options) => {
        if (!options?.owner) return real.createDatabase(name, options); // the template is fine
        created = { role: options.owner, database: name };
        throw new Error("disk full");
      },
    }));
    const logs = captureLogs();
    await expect(provisionTenant(deps, { name: "doomed" })).rejects.toThrow("disk full");
    expect(logs.filter((l) => l.alert)).toEqual([
      expect.objectContaining({
        level: "error",
        alert: "provisioning failed",
        tenantId: expect.any(String),
        errorMessage: "disk full",
      }),
    ]);
    expect(await cluster.roleExists(created.role ?? "r_missing")).toBe(false);
    expect(await cluster.databaseExists(created.database ?? "t_missing")).toBe(false);
    expect((await control.db.query("select 1 from tenants")).rowCount).toBe(0);
  });

  it("deletes everything: database, role, objects, keys, integrations, subscriptions, wake-up hint; and frees the name", async () => {
    const { provision, deps, cluster, control, blobs, bucket, tenantUrl } = await start();
    const tenant = await provision("acme");
    const [integration] = await listIntegrations(control.db, tenant.id);
    const { secret } = await createApiKey(control.db, tenant.id, integration?.id ?? "");
    await createIntegration(control.db, tenant.id, { name: "zapier", scopes: ["events"] });
    await insertSubscription(
      control.db,
      createSealer(generateSecretsKeyPair().publicKey),
      {
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        integrationId: integration?.id ?? "",
        destination: { kind: "webhook", url: "https://example.com/hook" },
        types: ["*"],
        scope: "own",
        description: "",
        secret: "whsec_test",
      },
      10,
    );
    const own = createTenantDb(await tenantUrl(tenant.id));
    await blobs.put(
      { tenantId: tenant.id, db: own },
      {
        kind: "message",
        key: "conversations/c1/messages/00000001.json",
        body: new TextEncoder().encode("{}"),
        mediaType: "application/json",
      },
    );
    await own.close();
    const objects = () => Array.fromAsync(bucket.list(tenantPrefix(tenant.id)));
    expect((await objects()).length).toBe(1);
    await hintTenantWork(control.db, tenant.id);

    await deleteTenant(deps, tenant.id);

    expect(await cluster.databaseExists(tenant.dbName)).toBe(false);
    expect(await cluster.roleExists(tenant.dbRole)).toBe(false);
    expect(await objects()).toEqual([]);
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    for (const table of [
      "api_keys",
      "subscriptions",
      "integrations",
      "tenant_db_credentials",
      "tenant_wakeups",
    ]) {
      expect(
        (await control.db.query(`select 1 from ${table} where tenant_id = $1`, [tenant.id]))
          .rowCount,
        table,
      ).toBe(0);
    }
    expect((await getTenant(control.db, tenant.id))?.status).toBe("deleted");
    await provision("acme"); // the name is free again
  });
});

describe("the install", () => {
  const settings = (overrides: Partial<InstanceSettings> = {}): InstanceSettings => ({
    tenantName: "acme",
    apiKey: newApiKey().key,
    admin: { email: "ada@example.com", password: PASSWORD },
    passwordCost: COST,
    ...overrides,
  });
  /** Bootstrap, and drop the tenant's database and role after the test. */
  const bootstrap = async (deps: ControlDeps, given: InstanceSettings) => {
    const tenant = await bootstrapInstance(deps, given);
    cleanups.push(() => deleteTenant(deps, tenant.id));
    return tenant;
  };

  it("makes the tenant, its key with every scope and its admin on the first start; the next start changes nothing", async () => {
    const { deps, control } = await start();
    const given = settings();
    const tenant = await bootstrap(deps, given);
    expect(tenant).toMatchObject({ name: "acme", status: "active" });

    const authenticated =
      (await authenticateApiKey(control.db, given.apiKey ?? "")) ?? expect.fail("key refused");
    expect(authenticated.tenant.id).toBe(tenant.id);
    expect(authenticated.integration.name).toBe("default");
    expect([...authenticated.integration.scopes].sort()).toEqual([...SCOPES].sort());
    const admin = (await findConsoleUser(control.db, "ada@example.com")) ?? expect.fail("no admin");
    expect(admin.tenantId).toBe(tenant.id);
    expect(await verifyPassword(PASSWORD, admin.passwordHash)).toBe(true);

    const again = await bootstrapInstance(deps, given);
    expect(again.id).toBe(tenant.id);
    expect(await listTenants(control.db)).toHaveLength(1);
    expect((await control.db.query("select 1 from api_keys")).rowCount).toBe(1);
    expect((await findConsoleUser(control.db, "ada@example.com"))?.passwordHash).toBe(
      admin.passwordHash,
    );
  });

  it("keeps config's key: a new one replaces the old, and one revoked elsewhere comes back", async () => {
    const { deps, control } = await start();
    const first = settings();
    const tenant = await bootstrap(deps, first);
    const firstKey = first.apiKey ?? "";
    const firstId = firstKey.split("_")[1] ?? "";
    expect(await revokeApiKey(control.db, tenant.id, firstId)).toBe(true);
    expect(await authenticateApiKey(control.db, firstKey)).toBeUndefined();
    await bootstrapInstance(deps, first);
    expect(await authenticateApiKey(control.db, firstKey)).toBeDefined();

    const second = settings({ apiKey: newApiKey().key });
    await bootstrapInstance(deps, second);
    expect(await authenticateApiKey(control.db, firstKey)).toBeUndefined();
    expect((await authenticateApiKey(control.db, second.apiKey ?? ""))?.tenant.id).toBe(tenant.id);
  });

  it("refuses a key that is not one, or whose id belongs to another key", async () => {
    const { deps } = await start();
    await expect(bootstrap(deps, settings({ apiKey: "not-a-key" }))).rejects.toThrow(
      /KERBY_API_KEY is not a Kerby API key/,
    );
    const given = settings();
    await bootstrapInstance(deps, given);
    const [prefix, id] = (given.apiKey ?? "").split("_");
    const sameId = `${prefix}_${id}_${randomBytes(32).toString("base64url")}`;
    await expect(bootstrapInstance(deps, settings({ apiKey: sameId }))).rejects.toThrow(
      /belongs to another key/,
    );
  });

  it("keeps config's admin: a new password replaces the old, a new email replaces the account and its sessions", async () => {
    const { deps, control } = await start();
    const tenant = await bootstrap(deps, settings());
    const ada = (await findConsoleUser(control.db, "ada@example.com")) ?? expect.fail("no admin");
    const session = await createConsoleSession(control.db, ada, new Date(Date.now() + 60_000));

    await bootstrapInstance(
      deps,
      settings({ admin: { email: "ada@example.com", password: "a new password" } }),
    );
    const changed = (await findConsoleUser(control.db, "ada@example.com")) ?? expect.fail("gone");
    expect(await verifyPassword(PASSWORD, changed.passwordHash)).toBe(false);
    expect(await verifyPassword("a new password", changed.passwordHash)).toBe(true);
    expect(await readConsoleSession(control.db, session)).toBeDefined();

    await bootstrapInstance(
      deps,
      settings({ admin: { email: "grace@example.com", password: PASSWORD } }),
    );
    expect(await findConsoleUser(control.db, "ada@example.com")).toBeUndefined();
    expect(await readConsoleSession(control.db, session)).toBeUndefined();
    expect((await findConsoleUser(control.db, "grace@example.com"))?.tenantId).toBe(tenant.id);
  });

  it("refuses to start with a second live tenant, naming the fix", async () => {
    const { deps, provision } = await start();
    await provision("acme");
    await provision("globex");
    await expect(bootstrapInstance(deps, settings())).rejects.toThrow(
      /holds 2 tenants, and a self-hosted Kerby serves one/,
    );
  });

  it("starts over from a tenant a previous start left unfinished, and wakes a suspended one", async () => {
    const { deps, control } = await start();
    const leftover = await insertTenant(control.db, {
      name: "acme",
      dbHost: deps.settings.clusterHost,
      dbPort: deps.settings.clusterPort,
    });
    const tenant = await bootstrap(deps, settings());
    expect(tenant.id).not.toBe(leftover.id);
    expect((await getTenant(control.db, leftover.id))?.status).toBe("deleted");

    await setTenantStatus(control.db, tenant.id, "suspended");
    expect((await bootstrapInstance(deps, settings())).status).toBe("active");
  });
});

describe("database passwords", () => {
  it("gives every tenant without a stored password a new one at startup, once, even from two processes", async () => {
    const { provision, control, cluster: admin, deps, tenantUrl } = await start();
    const legacy = await provision("legacy");
    const current = await provision("current");
    const kept = await readTenantDbPassword(control.db, tenantDbBox, current.id);
    // A tenant from before ADR 0009: a role with a derived password and nothing stored.
    await admin.setRolePassword(legacy.dbRole, "derived-from-the-old-shared-secret");
    await control.db.query("delete from tenant_db_credentials where tenant_id = $1", [legacy.id]);
    // A row whose role was never made (provisioning in flight) gets nothing.
    const inFlight = await insertTenant(control.db, { name: "in-flight", dbHost: "h", dbPort: 1 });

    const [first, second] = await Promise.all([
      ensureTenantDbPasswords(deps),
      ensureTenantDbPasswords(deps),
    ]);
    expect((first?.created ?? 0) + (second?.created ?? 0)).toBe(1);
    const legacyDb = createTenantDb(await tenantUrl(legacy.id), { max: 1 });
    cleanups.push(() => legacyDb.close());
    expect((await legacyDb.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
    expect(await readTenantDbPassword(control.db, tenantDbBox, current.id)).toBe(kept);
    expect(await readTenantDbPassword(control.db, tenantDbBox, inFlight.id)).toBeUndefined();

    // Every later start changes nothing.
    const stored = await readTenantDbPassword(control.db, tenantDbBox, legacy.id);
    expect(await ensureTenantDbPasswords(deps)).toEqual({ created: 0, resealed: 0 });
    expect(await readTenantDbPassword(control.db, tenantDbBox, legacy.id)).toBe(stored);
  });
});

describe("event retention", () => {
  it("deletes events and delivery attempts older than 30 days in every live tenant, and keeps recent ones", async () => {
    const { provision, deps, control, tenantDb } = await start();
    const tenants = [await provision("acme"), await provision("globex")];
    // A suspended tenant keeps its data, so retention still applies to it.
    await setTenantStatus(control.db, tenants[1]?.id ?? "", "suspended");
    const dbs = await Promise.all(tenants.map((tenant) => tenantDb(tenant.id)));
    const subscriptionId = crypto.randomUUID();
    for (const { db } of dbs) {
      for (const age of ["31 days", "29 days"]) {
        const conversation = await insertConversation(db, {
          integrationId: null,
          model: "m",
          system: "",
        });
        await db.query(
          `update events set created_at = now() - $1::interval where conversation_id = $2`,
          [age, conversation.id],
        );
        await recordDeliveryAttempt(db, {
          subscriptionId,
          eventIds: [],
          attempt: 1,
          outcome: "delivered",
          willRetry: false,
          status: 200,
          error: null,
          response: null,
          durationMs: 5,
        });
        await db.query(
          "update delivery_attempts set at = now() - $1::interval where id = (select max(id) from delivery_attempts)",
          [age],
        );
      }
    }

    expect(await pruneTenants(deps)).toMatchObject({
      tenants: 2,
      events: 2,
      attempts: 2,
      failed: [],
    });
    for (const { db } of dbs) {
      const ages = async (sql: string) =>
        (await db.query<{ days: number }>(sql)).rows.map((r) => r.days);
      expect(
        await ages("select extract(day from now() - created_at)::int as days from events"),
      ).toEqual([29]);
      expect(
        await ages("select extract(day from now() - at)::int as days from delivery_attempts"),
      ).toEqual([29]);
    }
  });

  it("logs a tenant that fails, goes on with the rest, and alerts once", async () => {
    const { provision, deps, cluster } = await start();
    const broken = await provision("broken");
    await provision("fine");
    await deps.pools.evict(broken.id);
    await cluster.dropDatabase(broken.dbName);
    const logs = captureLogs();
    const run = await pruneTenants(deps);
    expect(run).toMatchObject({ tenants: 1, failed: [broken.id] });
    expect(logs.filter((l) => l.alert)).toEqual([
      expect.objectContaining({ alert: "tenant retention failed", failed: 1 }),
    ]);
  });

  it("runs nightly at the next fixed UTC hour", () => {
    const hour = 60 * 60 * 1000;
    expect(untilNext(new Date("2026-11-22T01:30:00Z"), 3)).toBe(1.5 * hour);
    expect(untilNext(new Date("2026-11-22T03:00:00Z"), 3)).toBe(24 * hour);
    expect(untilNext(new Date("2026-11-22T23:00:00Z"), 3)).toBe(4 * hour);
  });
});

describe("migration fan-out", () => {
  it("brings a tenant database that is behind up to date, and reports one that cannot be reached", async () => {
    const { provision, deps, control, cluster, tenantUrl } = await start();
    const behind = await provision("behind");
    const gone = await provision("gone");

    // Make `behind` look like an older release: its conversation, search and tool migrations were never applied, and
    // its database never had `vector`, which its own role may not create: the fan-out installs it first.
    const own = createTenantDb(await tenantUrl(behind.id));
    await own.query(
      "drop table tool_oauth_flows, conversation_tools, integration_tools, tools, tool_servers, search_chunks, search_progress, search_settings, trace_segments, tool_executions, messages, conversations",
    );
    await own.query(
      "delete from schema_migrations where name like 'conversations/%' or name like 'search/%' or name like 'tools/%'",
    );
    await own.close();
    const asAdmin = createControlDb(cluster.urlFor(behind.dbName), { max: 1 });
    await asAdmin.query("drop extension vector");
    await asAdmin.close();
    const ownAgain = createTenantDb(await tenantUrl(behind.id), { max: 1 });
    await expect(ownAgain.query("create extension if not exists vector")).rejects.toThrow(
      /permission denied/,
    );
    await ownAgain.close();
    await control.db.query("update tenants set schema_version = null where id = $1", [behind.id]);
    await cluster.dropDatabase(gone.dbName);

    const logs = captureLogs();
    const run = await migrateAllTenants(deps);
    expect(run.migrated).toBe(1);
    expect(run.failed.map((f) => f.tenantId)).toEqual([gone.id]);
    expect(logs.filter((l) => l.level === "error")).toEqual([
      expect.objectContaining({ msg: "tenant migration failed", tenantId: gone.id }),
      expect.objectContaining({
        alert: "migration fan-out failed",
        failed: 1,
        migrated: 1,
        firstFailedTenant: gone.id,
      }),
    ]);

    const after = createTenantDb(await tenantUrl(behind.id));
    cleanups.push(() => after.close());
    expect((await after.query("select 1 from conversations")).rowCount).toBe(0);
    expect((await after.query("select 1 from search_settings")).rowCount).toBe(1);
    expect((await after.query("select 1 from tool_servers where kind = 'builtin'")).rowCount).toBe(
      1,
    );
    expect((await getTenant(control.db, behind.id))?.schemaVersion).toBe(
      readMigrations(tenantMigrationDirs).at(-1)?.name,
    );
  });
});
