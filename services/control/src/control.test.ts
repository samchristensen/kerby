import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { tenantPrefix } from "@kerby/blobs";
import { createEmptyTestBucket, createTestBlobs, createTestBucket } from "@kerby/blobs/testing";
import type {
  BackupResponse,
  ConsoleSignupResponse,
  CreateKeyResponse,
  CreateTenantResponse,
  ExportResponse,
  ReissueExportResponse,
  RestoreResponse,
  Tenant,
} from "@kerby/contracts";
import {
  authenticateApiKey,
  createConsoleSession,
  findConsoleUser,
  getTenant,
  insertConsoleUser,
  insertTenant,
  readConsoleSession,
  readTenantDbPassword,
  resolveTenantDbUrl,
} from "@kerby/control-plane";
import { createTestControlDb, type TestControlDb } from "@kerby/control-plane/testing";
import {
  insertConversation,
  postUserMessage,
  readMessages,
  tenantMigrationDirs,
} from "@kerby/conversations";
import {
  type ClusterAdmin,
  createClusterAdmin,
  createControlDb,
  createTenantDb,
  readMigrations,
  TenantPools,
} from "@kerby/db";
import { adminUrl } from "@kerby/db/testing";
import { configureLogging } from "@kerby/observability";
import { createSecretBox, generateBoxKey } from "@kerby/secrets";
import { serve } from "@kerby/serve";
import { afterEach, describe, expect, it } from "vitest";
import { createControlApp } from "./index.ts";
import { startNightly, untilNext } from "./runtime/nightly.ts";
import { BACKUP_LOCK_KEY, backupBuckets, checkBackupFreshness } from "./service/backup.ts";
import { ensureTenantDbPasswords } from "./service/db-credentials.ts";
import { deleteExpiredExports } from "./service/export.ts";
import { signUp } from "./service/signups.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import type { ControlDeps } from "./types/index.ts";

const TOKEN = "operator-token-for-tests";
const CONSOLE_TOKEN = "console-token-for-tests";
/** TENANT_DB_KEYS for every test: one box, as one deployment has. */
const tenantDbBox = createSecretBox([generateBoxKey()]);
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

/** End every session of `role`, as a restart or an idle timeout would, so its pools must log in again. */
async function endSessions(role: string): Promise<void> {
  const admin = createControlDb(adminUrl(), { max: 1 });
  try {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = $1", [
      role,
    ]);
    for (let i = 0; i < 50; i++) {
      const { rows } = await admin.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where usename = $1",
        [role],
      );
      if (rows[0]?.n === 0) break;
      await sleep(50);
    }
  } finally {
    await admin.close();
  }
  await sleep(100); // pools drop the clients the server ended
}

async function start(wrap?: (cluster: ClusterAdmin) => ClusterAdmin) {
  const control: TestControlDb = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const realCluster = createClusterAdmin(adminUrl());
  cleanups.push(() => realCluster.close());
  const cluster = wrap ? wrap(realCluster) : realCluster;
  const blobs = await createTestBlobs();
  const buckets = {
    primary: await createTestBucket(),
    exports: await createEmptyTestBucket(),
    backup: await createEmptyTestBucket(),
  };
  // The real clock unless a test sets one.
  let now: Date | undefined;
  const setNow = (at: Date) => {
    now = at;
  };
  /** The tenant's database URL as its own role, with the password control stored for it. */
  const tenantUrl = (tenantId: string) => resolveTenantDbUrl(control.db, tenantDbBox, tenantId);
  const pools = new TenantPools({ resolveUrl: tenantUrl });
  cleanups.push(() => pools.close());
  const adminHost = new URL(adminUrl());
  const templateDatabase = `kt_tpl_${randomBytes(4).toString("hex")}`;
  const deps: ControlDeps = {
    control: control.db,
    cluster,
    buckets,
    now: () => now ?? new Date(),
    pools,
    tenantDbBox,
    settings: {
      clusterHost: adminHost.hostname,
      clusterPort: Number(adminHost.port),
      templateDatabase,
      pgDumpPath: "pg_dump",
    },
  };
  await ensureTemplate(deps);
  await restrictClusterDatabases(deps);
  cleanups.push(() => realCluster.dropDatabase(templateDatabase));
  const server = await serve(createControlApp(deps, { operator: TOKEN, console: CONSOLE_TOKEN }), {
    host: "127.0.0.1",
    port: 0,
  });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const provision = async (name: string): Promise<CreateTenantResponse> => {
    const response = await call("POST", "/v1/operator/tenants", { name });
    expect(response.status).toBe(201);
    return (await response.json()) as CreateTenantResponse;
  };
  const tenantDb = async (tenantId: string) => {
    const db = createTenantDb(await tenantUrl(tenantId));
    cleanups.push(() => db.close());
    return { tenantId, db };
  };
  return {
    control,
    cluster: realCluster,
    blobs,
    buckets,
    deps,
    call,
    provision,
    setNow,
    tenantDb,
    tenantUrl,
  };
}

describe("operator API auth", () => {
  it("refuses a missing or wrong operator token and the tenant-facing health stays open", async () => {
    const { call } = await start();
    expect((await call("GET", "/v1/operator/tenants", undefined, null)).status).toBe(401);
    expect((await call("GET", "/v1/operator/tenants", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/v1/operator/tenants")).status).toBe(200);
    expect((await call("GET", "/healthz", undefined, null)).status).toBe(200);
  });
});

describe("provisioning", () => {
  it("creates a migrated database owned by a role that can reach only it, plus a working first key", async () => {
    const { call, provision, cluster, control, tenantUrl } = await start();
    const created = await provision("acme");
    const tenant = (await getTenant(control.db, created.tenant.id)) ?? expect.fail("no tenant row");

    expect(created.tenant.status).toBe("active");
    expect(created.tenant.schemaVersion).toBe(readMigrations(tenantMigrationDirs).at(-1)?.name);
    expect(await cluster.databaseExists(tenant.dbName)).toBe(true);
    expect(await cluster.roleExists(tenant.dbRole)).toBe(true);
    expect((await authenticateApiKey(control.db, created.secret))?.tenant.id).toBe(tenant.id);

    const own = createTenantDb(await tenantUrl(tenant.id));
    cleanups.push(() => own.close());
    const owners = await own.query<{ tableowner: string }>(
      "select distinct tableowner from pg_tables where tablename in ('conversations', 'messages', 'blobs')",
    );
    expect(owners.rows).toEqual([{ tableowner: tenant.dbRole }]);
    await own.query("insert into conversations (model) values ('m')"); // the role can use its schema

    // A second tenant's role cannot connect to the first tenant's database.
    const other = await provision("globex");
    const otherTenant =
      (await getTenant(control.db, other.tenant.id)) ?? expect.fail("no tenant row");
    const crossUrl = new URL(await tenantUrl(otherTenant.id));
    crossUrl.pathname = `/${tenant.dbName}`;
    const intruder = createTenantDb(crossUrl.toString(), { max: 1 });
    cleanups.push(() => intruder.close());
    await expect(intruder.query("select 1")).rejects.toThrow(/permission denied|not allowed/);

    expect((await call("GET", `/v1/operator/tenants/${tenant.id}`)).status).toBe(200);
  });

  it("refuses a tenant role on the maintenance databases and the template, and still provisions from it", async () => {
    const { provision, control, cluster, deps, tenantUrl } = await start();
    const created = await provision("acme");
    const tenant = (await getTenant(control.db, created.tenant.id)) ?? expect.fail("no tenant row");
    // Over the network address with the role's own password, as a tenant would try.
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
    const otherTenant =
      (await getTenant(control.db, other.tenant.id)) ?? expect.fail("no tenant row");
    expect(await cluster.databaseExists(otherTenant.dbName)).toBe(true);
  });

  it("rejects a duplicate or malformed name", async () => {
    const { call, provision } = await start();
    await provision("acme");
    expect((await call("POST", "/v1/operator/tenants", { name: "acme" })).status).toBe(409);
    expect((await call("POST", "/v1/operator/tenants", { name: "Not Valid" })).status).toBe(400);
    expect((await call("POST", "/v1/operator/tenants", {})).status).toBe(400);
  });

  it("provisions several tenants at once from one template", async () => {
    const { call, cluster, control } = await start();
    const responses = await Promise.all(
      ["t1", "t2", "t3", "t4", "t5"].map((name) => call("POST", "/v1/operator/tenants", { name })),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const tenants = (await Promise.all(responses.map((r) => r.json()))) as CreateTenantResponse[];
    for (const { tenant } of tenants) {
      const row = (await getTenant(control.db, tenant.id)) ?? expect.fail("no tenant row");
      expect(await cluster.databaseExists(row.dbName)).toBe(true);
    }
  });

  it("leaves nothing behind when provisioning fails halfway", async () => {
    let created: { role?: string | undefined; database?: string | undefined } = {};
    const { call, control, cluster } = await start((real) => ({
      ...real,
      createDatabase: async (name, options) => {
        if (!options?.owner) return real.createDatabase(name, options); // the template is fine
        created = { role: options.owner, database: name };
        throw new Error("disk full");
      },
    }));
    const logs = captureLogs();
    const response = await call("POST", "/v1/operator/tenants", { name: "doomed" });
    expect(response.status).toBe(500);
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
});

describe("lifecycle", () => {
  it("suspends and resumes, and refuses to suspend what is not active", async () => {
    const { call, provision } = await start();
    const { tenant } = await provision("acme");
    const suspended = (await (
      await call("POST", `/v1/operator/tenants/${tenant.id}/suspend`)
    ).json()) as Tenant;
    expect(suspended.status).toBe("suspended");
    const resumed = (await (
      await call("POST", `/v1/operator/tenants/${tenant.id}/resume`)
    ).json()) as Tenant;
    expect(resumed.status).toBe("active");
    expect(
      (await call("POST", "/v1/operator/tenants/00000000-0000-4000-8000-000000000000/suspend"))
        .status,
    ).toBe(404);
  });

  it("rotates a key: the old one stops working, the new one works", async () => {
    const { call, provision, control } = await start();
    const { tenant, apiKey, secret } = await provision("acme");
    const rotated = (await (
      await call("POST", `/v1/operator/tenants/${tenant.id}/keys/${apiKey.id}/rotate`)
    ).json()) as CreateKeyResponse;
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    expect((await authenticateApiKey(control.db, rotated.secret))?.tenant.id).toBe(tenant.id);
    // The old key id is gone for good: rotating it again is a 404.
    expect(
      (await call("POST", `/v1/operator/tenants/${tenant.id}/keys/${apiKey.id}/rotate`)).status,
    ).toBe(404);

    const extra = (await (
      await call("POST", `/v1/operator/tenants/${tenant.id}/keys`, { label: "ci" })
    ).json()) as CreateKeyResponse;
    expect(
      (await call("DELETE", `/v1/operator/tenants/${tenant.id}/keys/${extra.apiKey.id}`)).status,
    ).toBe(204);
    expect(await authenticateApiKey(control.db, extra.secret)).toBeUndefined();
  });

  it("deletes everything: database, role, objects, keys; and frees the name", async () => {
    const { call, provision, cluster, control, blobs, buckets, tenantUrl } = await start();
    const { tenant, secret } = await provision("acme");
    const row = (await getTenant(control.db, tenant.id)) ?? expect.fail("no tenant row");
    const own = createTenantDb(await tenantUrl(row.id));
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
    const objects = () => Array.fromAsync(buckets.primary.list(tenantPrefix(tenant.id)));
    expect((await objects()).length).toBe(1);

    expect((await call("DELETE", `/v1/operator/tenants/${tenant.id}`)).status).toBe(204);

    expect(await cluster.databaseExists(row.dbName)).toBe(false);
    expect(await cluster.roleExists(row.dbRole)).toBe(false);
    expect(await objects()).toEqual([]);
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    expect(
      (await control.db.query("select 1 from api_keys where tenant_id = $1", [tenant.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await control.db.query("select 1 from tenant_db_credentials where tenant_id = $1", [
          tenant.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await getTenant(control.db, tenant.id))?.status).toBe("deleted");
    expect((await call("GET", `/v1/operator/tenants/${tenant.id}`)).status).toBe(404);
    expect((await call("DELETE", `/v1/operator/tenants/${tenant.id}`)).status).toBe(404);
    await provision("acme"); // the name is free again
  });

  it("records every operator action in the audit log without content", async () => {
    const { call, provision, control } = await start();
    const { tenant } = await provision("acme");
    await call("POST", `/v1/operator/tenants/${tenant.id}/suspend`);
    const { rows } = await control.db.query<{ action: string; actor: string }>(
      "select action, actor from audit_log order by id",
    );
    expect(rows).toEqual([
      { action: "tenant.create", actor: "operator" },
      { action: "tenant.suspend", actor: "operator" },
    ]);
  });
});

describe("console sign-up", () => {
  const passwordHash = "scrypt$17$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaA==";
  const signup = (body: unknown, token: string | null = CONSOLE_TOKEN) =>
    start().then(({ call }) => call("POST", "/v1/console/signups", body, token));

  it("provisions a tenant with its first person and key, audited as the console", async () => {
    const h = await start();
    const response = await h.call(
      "POST",
      "/v1/console/signups",
      { name: "acme", email: " Ada@Example.com ", passwordHash },
      CONSOLE_TOKEN,
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as ConsoleSignupResponse;
    const tenant = (await getTenant(h.control.db, created.tenantId)) ?? expect.fail("no tenant");
    expect(tenant).toMatchObject({ name: "acme", status: "active" });
    expect(await h.cluster.databaseExists(tenant.dbName)).toBe(true);
    expect((await authenticateApiKey(h.control.db, created.secret))?.tenant.id).toBe(tenant.id);
    expect(await findConsoleUser(h.control.db, "ada@example.com")).toMatchObject({
      id: created.userId,
      tenantId: tenant.id,
      passwordHash,
    });
    const { rows } = await h.control.db.query<{ action: string; actor: string }>(
      "select action, actor from audit_log order by id",
    );
    expect(rows).toEqual([
      { action: "tenant.create", actor: "console" },
      { action: "console.signup", actor: "console" },
    ]);
  });

  it("opens with the console's token only, and that token opens nothing else", async () => {
    const body = { name: "acme", email: "ada@example.com", passwordHash };
    expect((await signup(body, null)).status).toBe(401);
    expect((await signup(body, TOKEN)).status).toBe(401);
    const { call } = await start();
    expect((await call("GET", "/v1/operator/tenants", undefined, CONSOLE_TOKEN)).status).toBe(401);
    expect((await call("POST", "/v1/operator/tenants", { name: "x" }, CONSOLE_TOKEN)).status).toBe(
      401,
    );
  });

  it("refuses a taken email or workspace name, and a body that is not a sign-up", async () => {
    const h = await start();
    const post = (body: unknown) => h.call("POST", "/v1/console/signups", body, CONSOLE_TOKEN);
    expect((await post({ name: "acme", email: "ada@example.com", passwordHash })).status).toBe(201);
    const tenants = async () => (await h.control.db.query("select 1 from tenants")).rowCount;

    const sameEmail = await post({ name: "globex", email: "ADA@example.com", passwordHash });
    expect(sameEmail.status).toBe(409);
    expect(await sameEmail.json()).toMatchObject({ error: { code: "email_taken" } });
    const sameName = await post({ name: "acme", email: "bob@example.com", passwordHash });
    expect(sameName.status).toBe(409);
    expect(await sameName.json()).toMatchObject({ error: { code: "name_taken" } });
    expect(await tenants()).toBe(1);

    for (const bad of [
      { name: "Acme Inc", email: "c@example.com", passwordHash },
      { name: "c", email: "not-an-email", passwordHash },
      { name: "c", email: "c@example.com", passwordHash: "hunter2" },
      { name: "c", email: "c@example.com" },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await tenants()).toBe(1);
  });

  it("leaves no tenant behind when another sign-up takes the email first", async () => {
    const h = await start();
    // The other sign-up lands between the check and this one's insert.
    const control = {
      ...h.deps.control,
      async query(text: string, params?: readonly unknown[]) {
        if (text.startsWith("insert into console_users")) {
          const other = await insertTenant(h.control.db, { name: "other", dbHost: "h", dbPort: 1 });
          await insertConsoleUser(h.control.db, {
            tenantId: other.id,
            email: "ada@example.com",
            passwordHash,
          });
        }
        return h.deps.control.query(text, params);
      },
    } as typeof h.deps.control;
    await expect(
      signUp({ ...h.deps, control }, { name: "acme", email: "ada@example.com", passwordHash }),
    ).rejects.toMatchObject({ code: "email_taken" });
    const acme = await h.control.db.query<{ status: string; db_name: string }>(
      "select status, db_name from tenants where name = 'acme'",
    );
    expect(acme.rows[0]?.status).toBe("deleted");
    expect(await h.cluster.databaseExists(acme.rows[0]?.db_name ?? "")).toBe(false);
    expect((await h.control.db.query("select 1 from api_keys")).rowCount).toBe(0);
  });

  it("deleting the tenant removes its people and sessions and frees the email", async () => {
    const h = await start();
    const post = (name: string) =>
      h.call(
        "POST",
        "/v1/console/signups",
        { name, email: "ada@example.com", passwordHash },
        CONSOLE_TOKEN,
      );
    const created = (await (await post("acme")).json()) as ConsoleSignupResponse;
    const token = await createConsoleSession(
      h.control.db,
      { id: created.userId, tenantId: created.tenantId },
      new Date(Date.now() + 60_000),
    );
    expect((await h.call("DELETE", `/v1/operator/tenants/${created.tenantId}`)).status).toBe(204);
    expect(await readConsoleSession(h.control.db, token)).toBeUndefined();
    expect(await findConsoleUser(h.control.db, "ada@example.com")).toBeUndefined();
    expect((await post("acme")).status).toBe(201);
  });
});

describe("database passwords", () => {
  const refused = /password authentication failed/;

  it("rotates a tenant's password: the old one is refused, the new one works, and open pools log in again", async () => {
    const { call, provision, control, deps, tenantUrl } = await start();
    const { tenant } = await provision("acme");
    const row = (await getTenant(control.db, tenant.id)) ?? expect.fail("no tenant row");
    const before = await tenantUrl(tenant.id);
    // Control's own pool for the tenant is open (provisioning migrated through it) and holds the old password.
    await deps.pools.use(tenant.id, (db) => db.query("select 1"));

    const response = await call("POST", `/v1/operator/tenants/${tenant.id}/rotate-db-password`);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(new URL(before).password);
    const after = await tenantUrl(tenant.id);
    expect(new URL(after).password).not.toBe(new URL(before).password);

    const old = createTenantDb(before, { max: 1 });
    cleanups.push(() => old.close());
    await expect(old.query("select 1")).rejects.toThrow(refused);
    const fresh = createTenantDb(after, { max: 1 });
    cleanups.push(() => fresh.close());
    expect((await fresh.query("select 1 as one")).rows).toEqual([{ one: 1 }]);

    // End the pool's sessions so its next query logs in: refused (28P01), resolved again, retried with the new one.
    await endSessions(row.dbRole);
    expect((await deps.pools.use(tenant.id, (db) => db.query("select 2 as two"))).rows).toEqual([
      { two: 2 },
    ]);

    const { rows } = await control.db.query<{ action: string }>(
      "select action from audit_log where tenant_id = $1 order by id",
      [tenant.id],
    );
    expect(rows.map((r) => r.action)).toEqual(["tenant.create", "tenant.rotate_db_password"]);
    expect(
      (await call("POST", `/v1/operator/tenants/${crypto.randomUUID()}/rotate-db-password`)).status,
    ).toBe(404);
  });

  it("gives every tenant without a stored password a new one at startup, once, even from two replicas", async () => {
    const { provision, control, cluster: admin, deps, tenantUrl } = await start();
    const legacy = await provision("legacy");
    const current = await provision("current");
    const legacyRow = (await getTenant(control.db, legacy.tenant.id)) ?? expect.fail("no row");
    const kept = await readTenantDbPassword(control.db, tenantDbBox, current.tenant.id);
    // A tenant from before ADR 0009: a role with a derived password and nothing stored.
    await admin.setRolePassword(legacyRow.dbRole, "derived-from-the-old-shared-secret");
    await control.db.query("delete from tenant_db_credentials where tenant_id = $1", [
      legacy.tenant.id,
    ]);
    // A row whose role was never made (provisioning in flight) gets nothing.
    const inFlight = await insertTenant(control.db, { name: "in-flight", dbHost: "h", dbPort: 1 });

    const [first, second] = await Promise.all([
      ensureTenantDbPasswords(deps),
      ensureTenantDbPasswords(deps),
    ]);
    expect((first?.created ?? 0) + (second?.created ?? 0)).toBe(1);
    const legacyDb = createTenantDb(await tenantUrl(legacy.tenant.id), { max: 1 });
    cleanups.push(() => legacyDb.close());
    expect((await legacyDb.query("select 1 as one")).rows).toEqual([{ one: 1 }]);
    expect(await readTenantDbPassword(control.db, tenantDbBox, current.tenant.id)).toBe(kept);
    expect(await readTenantDbPassword(control.db, tenantDbBox, inFlight.id)).toBeUndefined();

    // Every later start changes nothing.
    const stored = await readTenantDbPassword(control.db, tenantDbBox, legacy.tenant.id);
    expect(await ensureTenantDbPasswords(deps)).toEqual({ created: 0, resealed: 0 });
    expect(await readTenantDbPassword(control.db, tenantDbBox, legacy.tenant.id)).toBe(stored);
  });
});

describe("export", () => {
  it("uploads a pg_dump and the object listing, downloadable by URL until it expires, and audits each URL", async () => {
    const { call, provision, blobs, tenantDb, setNow, control } = await start();
    const { tenant } = await provision("acme");
    await blobs.put(await tenantDb(tenant.id), {
      kind: "message",
      key: "m/1.json",
      body: new Uint8Array([1, 2, 3]),
      mediaType: "application/octet-stream",
    });

    const response = await call("POST", `/v1/operator/tenants/${tenant.id}/export`);
    expect(response.status).toBe(200);
    const exported = (await response.json()) as ExportResponse;
    expect(exported).toMatchObject({ objectCount: 1, objectPrefix: `t/${tenant.id}/` });
    expect(Date.parse(exported.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    const dump = await fetch(exported.dumpUrl);
    expect(dump.status).toBe(200);
    expect(
      Buffer.from(await dump.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe("PGDMP");
    expect(await (await fetch(exported.objectsUrl)).json()).toEqual([{ key: "m/1.json", size: 3 }]);
    const { rows } = await control.db.query<{ action: string; key: string | null }>(
      "select action, detail->>'key' as key from audit_log where tenant_id = $1 and action like '%export%' order by id",
      [tenant.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "tenant.export",
      "export.url_issued",
      "export.url_issued",
    ]);
    expect(rows[1]?.key).toMatch(new RegExp(`^${tenant.id}/.*\\.dump$`));

    // Exported a day and a minute ago: the URLs have expired.
    setNow(new Date(Date.now() - (24 * 60 + 1) * 60 * 1000));
    const old = (await (
      await call("POST", `/v1/operator/tenants/${tenant.id}/export`)
    ).json()) as ExportResponse;
    const refused = await fetch(old.dumpUrl);
    expect(refused.status).toBe(403);
    await refused.body?.cancel();
  });

  it("retention deletes exports older than 30 days only, a deleted tenant's included", async () => {
    const { call, provision, buckets, setNow, deps } = await start();
    const { tenant } = await provision("acme");
    const day = 24 * 60 * 60 * 1000;
    const first = Date.parse("2026-01-01T00:00:00.000Z");
    const exportAt = async (at: number) => {
      setNow(new Date(at));
      expect((await call("POST", `/v1/operator/tenants/${tenant.id}/export`)).status).toBe(200);
    };
    await exportAt(first);
    await exportAt(first + 2 * day);
    expect((await call("DELETE", `/v1/operator/tenants/${tenant.id}`)).status).toBe(204);
    const kept = async () =>
      (await Array.fromAsync(buckets.exports.list(""))).map((o) => o.key.split("/")[1]).sort();

    // 30 days after the first export: nothing is older than 30 days yet.
    setNow(new Date(first + 30 * day));
    expect(await deleteExpiredExports(deps)).toBe(0);
    // A day later the first export (dump and listing) goes, and the second stays.
    setNow(new Date(first + 31 * day));
    expect(await deleteExpiredExports(deps)).toBe(2);
    expect(await kept()).toEqual([
      "2026-01-03T00-00-00-000Z.dump",
      "2026-01-03T00-00-00-000Z.objects.json",
    ]);
  });

  describe("reissue", () => {
    const reissue = async (
      call: (method: string, path: string, body?: unknown) => Promise<Response>,
      id: string,
      body: object = {},
    ) => call("POST", `/v1/operator/tenants/${id}/export/reissue`, body);

    it("gives new URLs to the same export, also after the tenant is deleted, and audits them", async () => {
      const { call, provision, blobs, tenantDb, control } = await start();
      const { tenant } = await provision("acme");
      await blobs.put(await tenantDb(tenant.id), {
        kind: "message",
        key: "m/1.json",
        body: new Uint8Array([1, 2, 3]),
        mediaType: "application/octet-stream",
      });
      const exported = (await (
        await call("POST", `/v1/operator/tenants/${tenant.id}/export`)
      ).json()) as ExportResponse;

      const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());
      const again = async () => {
        const response = await reissue(call, tenant.id);
        expect(response.status).toBe(200);
        return (await response.json()) as ReissueExportResponse;
      };
      const first = await again();
      expect(first).toMatchObject({ objectPrefix: `t/${tenant.id}/` });
      expect(first).not.toHaveProperty("objectCount");
      expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(await download(first.dumpUrl)).toEqual(await download(exported.dumpUrl));
      expect(await download(first.objectsUrl)).toEqual(await download(exported.objectsUrl));

      expect((await call("DELETE", `/v1/operator/tenants/${tenant.id}`)).status).toBe(204);
      const afterDelete = await again();
      expect(await download(afterDelete.dumpUrl)).toEqual(await download(exported.dumpUrl));
      expect(await (await fetch(afterDelete.objectsUrl)).json()).toEqual([
        { key: "m/1.json", size: 3 },
      ]);

      const { rows } = await control.db.query<{ action: string }>(
        "select action from audit_log where tenant_id = $1 and action like '%export%' order by id",
        [tenant.id],
      );
      expect(rows.map((r) => r.action)).toEqual([
        "tenant.export",
        "export.url_issued",
        "export.url_issued",
        "tenant.export_reissue",
        "export.url_issued",
        "export.url_issued",
        "tenant.export_reissue",
        "export.url_issued",
        "export.url_issued",
      ]);
    });

    it("takes the newest export, or the one named by its stamp", async () => {
      const { call, provision, setNow } = await start();
      const { tenant } = await provision("acme");
      const older = Date.now() - 2 * 60 * 60 * 1000;
      const newer = older + 60 * 60 * 1000;
      for (const at of [older, newer]) {
        setNow(new Date(at));
        expect((await call("POST", `/v1/operator/tenants/${tenant.id}/export`)).status).toBe(200);
      }
      setNow(new Date());
      const stamp = (at: number) => new Date(at).toISOString().replaceAll(/[:.]/g, "-");
      const issued = async (body: object) =>
        (await (await reissue(call, tenant.id, body)).json()) as ReissueExportResponse;

      const latest = await issued({});
      expect(latest.exportedAt).toBe(new Date(newer).toISOString());
      expect(new URL(latest.dumpUrl).pathname).toContain(`/${tenant.id}/${stamp(newer)}.dump`);
      const chosen = await issued({ stamp: stamp(older) });
      expect(chosen.exportedAt).toBe(new Date(older).toISOString());
      expect(new URL(chosen.objectsUrl).pathname).toContain(
        `/${tenant.id}/${stamp(older)}.objects.json`,
      );
      expect((await reissue(call, tenant.id, { stamp: "2020-01-01T00-00-00-000Z" })).status).toBe(
        404,
      );
      expect((await reissue(call, tenant.id, { stamp: "../x" })).status).toBe(400);
    });

    it("never reaches another tenant's keys, and 404s where there is no export", async () => {
      const { call, provision, buckets } = await start();
      const exporter = await provision("exporter");
      const other = await provision("other");
      expect((await call("POST", `/v1/operator/tenants/${exporter.tenant.id}/export`)).status).toBe(
        200,
      );

      expect((await reissue(call, other.tenant.id)).status).toBe(404);
      // A tenant id that is a prefix or a path, not a tenant id.
      for (const id of [
        exporter.tenant.id.slice(0, 8),
        exporter.tenant.id.toUpperCase(),
        `${exporter.tenant.id}/..`,
        encodeURIComponent(`${other.tenant.id}/../${exporter.tenant.id}`),
        "",
      ]) {
        expect((await reissue(call, id)).status, id).toBe(404);
      }
      // An upload cut short (a dump with no listing) is not an export.
      await buckets.exports.write(
        `${other.tenant.id}/2026-01-01T00-00-00-000Z.dump`,
        new Uint8Array([1]),
        "application/octet-stream",
      );
      expect((await reissue(call, other.tenant.id)).status).toBe(404);
    });

    it("404s once retention has deleted the export", async () => {
      const { call, provision, setNow, deps } = await start();
      const { tenant } = await provision("acme");
      const day = 24 * 60 * 60 * 1000;
      const first = Date.parse("2026-01-01T00:00:00.000Z");
      setNow(new Date(first));
      expect((await call("POST", `/v1/operator/tenants/${tenant.id}/export`)).status).toBe(200);
      setNow(new Date(first + 29 * day));
      expect((await reissue(call, tenant.id)).status).toBe(200);
      setNow(new Date(first + 31 * day));
      expect(await deleteExpiredExports(deps)).toBe(2);
      expect((await reissue(call, tenant.id)).status).toBe(404);
    });
  });
});

describe("bucket backup", () => {
  it("copies new objects only, removes deleted tenants' copies, and a restore makes a conversation read again", async () => {
    const { call, provision, blobs, buckets, tenantDb } = await start();
    const kept = await provision("kept");
    const gone = await provision("gone");
    const ctx = await tenantDb(kept.tenant.id);
    const conversation = await insertConversation(ctx.db, { model: "m", system: "" });
    await postUserMessage(ctx, blobs, conversation.id, [{ type: "text", text: "hello" }], {
      storageBytes: 1024 ** 3,
    });
    await blobs.put(await tenantDb(gone.tenant.id), {
      kind: "message",
      key: "m/1.json",
      body: new Uint8Array([1]),
      mediaType: "application/octet-stream",
    });
    const backup = async () => {
      const response = await call("POST", "/v1/operator/backup");
      expect(response.status).toBe(200);
      return (await response.json()) as BackupResponse;
    };
    const backedUp = (id: string) => Array.fromAsync(buckets.backup.list(tenantPrefix(id)));

    expect(await backup()).toMatchObject({
      copied: 2,
      unchanged: 0,
      objectsDeleted: 0,
      failed: [],
    });
    expect(await backup()).toMatchObject({ copied: 0, unchanged: 2, bytes: 0 });

    // The deletion obligation: a deleted tenant's copy goes at the next run.
    expect((await call("DELETE", `/v1/operator/tenants/${gone.tenant.id}`)).status).toBe(204);
    expect((await backedUp(gone.tenant.id)).length).toBe(1);
    expect(await backup()).toMatchObject({ copied: 0, deletedTenants: 1, objectsDeleted: 1 });
    expect(await backedUp(gone.tenant.id)).toEqual([]);

    // Lose the message body in the primary: the conversation no longer reads.
    const [lost] = await Array.fromAsync(buckets.primary.list(tenantPrefix(kept.tenant.id)));
    await buckets.primary.deleteKeys([lost?.key ?? expect.fail("no object")]);
    const firstPage = { after: 0, limit: 100 };
    await expect(readMessages(ctx, blobs, conversation.id, firstPage)).rejects.toThrow();

    const restore = async (body: object) =>
      (await (await call("POST", "/v1/operator/backup/restore", body)).json()) as RestoreResponse;
    expect(await restore({ tenantId: kept.tenant.id })).toMatchObject({
      tenants: 1,
      restored: 1,
      failed: [],
    });
    const { messages } = await readMessages(ctx, blobs, conversation.id, firstPage);
    expect(messages.map((m) => m.message.content)).toEqual([[{ type: "text", text: "hello" }]]);
    // Nothing is missing any more; a deleted tenant cannot be restored.
    expect(await restore({})).toMatchObject({ restored: 0, failed: [] });
    expect(
      (await call("POST", "/v1/operator/backup/restore", { tenantId: gone.tenant.id })).status,
    ).toBe(404);
  });

  it("lets one run at a time: a second caller gets a conflict", async () => {
    const { call, deps } = await start();
    // Hold the lock on another connection, as another control instance's run would.
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const holder = deps.control.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [BACKUP_LOCK_KEY]);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    expect((await call("POST", "/v1/operator/backup")).status).toBe(409);
    expect((await call("POST", "/v1/operator/backup/restore", {})).status).toBe(409);
    release.resolve();
    await holder;
    expect((await call("POST", "/v1/operator/backup")).status).toBe(200);
  });

  it("runs nightly at the next fixed UTC hour", () => {
    const hour = 60 * 60 * 1000;
    expect(untilNext(new Date("2026-11-22T01:30:00Z"), 3)).toBe(1.5 * hour);
    expect(untilNext(new Date("2026-11-22T03:00:00Z"), 3)).toBe(24 * hour);
    expect(untilNext(new Date("2026-11-22T23:00:00Z"), 3)).toBe(4 * hour);
  });

  describe("dead-man check", () => {
    const hour = 60 * 60 * 1000;
    const overdueAlerts = (logs: Record<string, unknown>[]) =>
      logs.filter((l) => l.alert === "bucket backup overdue");

    it("stays quiet after a fresh success and alerts once the last one is older than 26 hours", async () => {
      const { call, deps, setNow } = await start();
      const logs = captureLogs();
      expect((await call("POST", "/v1/operator/backup")).status).toBe(200);
      const succeededAt = Date.now();
      // The process started long ago, so only the recorded success can keep the check quiet.
      const startedAt = new Date(succeededAt - 100 * hour);

      setNow(new Date(succeededAt + 25 * hour));
      await checkBackupFreshness(deps, startedAt);
      expect(overdueAlerts(logs)).toEqual([]);

      setNow(new Date(succeededAt + 27.5 * hour));
      await checkBackupFreshness(deps, startedAt);
      expect(overdueAlerts(logs)).toEqual([
        expect.objectContaining({ recorded: true, ageHours: 27, maxAgeHours: 26 }),
      ]);
    });

    it("does not count a run with a failing tenant", async () => {
      const { provision, deps, control, setNow } = await start();
      await provision("acme");
      const logs = captureLogs();
      const broken: ControlDeps = {
        ...deps,
        buckets: {
          ...deps.buckets,
          primary: {
            ...deps.buckets.primary,
            list: () => {
              throw new Error("primary bucket unreachable");
            },
          },
        },
      };
      expect((await backupBuckets(broken)).failed).toHaveLength(1);
      expect(logs.filter((l) => l.alert === "bucket backup failed")).toHaveLength(1);
      const { rows } = await control.db.query(
        "select 1 from audit_log where action like 'bucket_backup%'",
      );
      expect(rows).toEqual([]);

      const startedAt = new Date();
      setNow(new Date(startedAt.getTime() + 27 * hour));
      await checkBackupFreshness(deps, startedAt);
      expect(overdueAlerts(logs)).toEqual([expect.objectContaining({ recorded: false })]);
    });

    it("gives a process with no record 26 hours from its start, then alerts", async () => {
      const { deps, setNow } = await start();
      const logs = captureLogs();
      const startedAt = new Date("2026-11-22T10:00:00Z");

      setNow(startedAt);
      await checkBackupFreshness(deps, startedAt);
      setNow(new Date(startedAt.getTime() + 25 * hour));
      await checkBackupFreshness(deps, startedAt);
      expect(overdueAlerts(logs)).toEqual([]);

      setNow(new Date(startedAt.getTime() + 27 * hour));
      await checkBackupFreshness(deps, startedAt);
      expect(overdueAlerts(logs)).toEqual([
        expect.objectContaining({ recorded: false, ageHours: 27 }),
      ]);
    });

    it("checks once at startup, and stop() waits for it and clears the hourly timer", async () => {
      const { deps, control } = await start();
      const logs = captureLogs();
      // The last success was 30 hours ago: control was down at 03:00 and has just restarted.
      await control.db.query(
        "insert into audit_log (tenant_id, actor, action, at) values (null, 'system', 'bucket_backup.succeeded', now() - interval '30 hours')",
      );
      await startNightly(deps).stop();
      expect(overdueAlerts(logs)).toEqual([
        expect.objectContaining({ recorded: true, ageHours: 30 }),
      ]);
    });
  });
});

describe("migration fan-out", () => {
  it("brings a tenant database that is behind up to date, and reports one that cannot be reached", async () => {
    const { call, provision, control, cluster, tenantUrl } = await start();
    const behind = await provision("behind");
    const gone = await provision("gone");
    const behindRow =
      (await getTenant(control.db, behind.tenant.id)) ?? expect.fail("no tenant row");
    const goneRow = (await getTenant(control.db, gone.tenant.id)) ?? expect.fail("no tenant row");

    // Make `behind` look like an older release: its newest migration (the tool tables) was never applied.
    const own = createTenantDb(await tenantUrl(behindRow.id));
    await own.query("drop table conversation_tools, integration_tools, tools, tool_servers");
    await own.query("delete from schema_migrations where name like 'tools/%'");
    await own.close();
    await control.db.query("update tenants set schema_version = null where id = $1", [
      behind.tenant.id,
    ]);
    await cluster.dropDatabase(goneRow.dbName);

    const logs = captureLogs();
    const run = (await (await call("POST", "/v1/operator/migrate")).json()) as {
      migrated: number;
      failed: { tenantId: string }[];
    };
    expect(run.migrated).toBe(1);
    expect(run.failed.map((f) => f.tenantId)).toEqual([gone.tenant.id]);
    expect(logs.filter((l) => l.level === "error")).toEqual([
      expect.objectContaining({ msg: "tenant migration failed", tenantId: gone.tenant.id }),
      expect.objectContaining({
        alert: "migration fan-out failed",
        failed: 1,
        migrated: 1,
        firstFailedTenant: gone.tenant.id,
      }),
    ]);

    const after = createTenantDb(await tenantUrl(behindRow.id));
    cleanups.push(() => after.close());
    expect((await after.query("select 1 from tool_servers where kind = 'builtin'")).rowCount).toBe(
      1,
    );
    expect((await getTenant(control.db, behind.tenant.id))?.schemaVersion).toBe(
      readMigrations(tenantMigrationDirs).at(-1)?.name,
    );
  });
});
