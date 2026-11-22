import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { tenantPrefix } from "@kerby/blobs";
import { createEmptyTestBucket, createTestBlobs, createTestBucket } from "@kerby/blobs/testing";
import type {
  BackupResponse,
  CreateKeyResponse,
  CreateTenantResponse,
  ExportResponse,
  RestoreResponse,
  Tenant,
} from "@kerby/contracts";
import {
  authenticateApiKey,
  getTenant,
  insertTenant,
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
import { untilNext } from "./runtime/nightly.ts";
import { BACKUP_LOCK_KEY } from "./service/backup.ts";
import { ensureTenantDbPasswords } from "./service/db-credentials.ts";
import { deleteExpiredExports } from "./service/export.ts";
import { ensureTemplate, restrictClusterDatabases } from "./service/template.ts";
import type { ControlDeps } from "./types/index.ts";

const TOKEN = "operator-token-for-tests";
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
  const server = await serve(createControlApp(deps, TOKEN), { host: "127.0.0.1", port: 0 });
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
});

describe("migration fan-out", () => {
  it("brings a tenant database that is behind up to date, and reports one that cannot be reached", async () => {
    const { call, provision, control, cluster, tenantUrl } = await start();
    const behind = await provision("behind");
    const gone = await provision("gone");
    const behindRow =
      (await getTenant(control.db, behind.tenant.id)) ?? expect.fail("no tenant row");
    const goneRow = (await getTenant(control.db, gone.tenant.id)) ?? expect.fail("no tenant row");

    // Make `behind` look like an older release: its newest migration was never applied.
    const own = createTenantDb(await tenantUrl(behindRow.id));
    await own.query("drop table tool_executions, messages, conversations");
    await own.query("delete from schema_migrations where name like 'conversations/%'");
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
    expect((await after.query("select 1 from conversations")).rowCount).toBe(0);
    expect((await getTenant(control.db, behind.tenant.id))?.schemaVersion).toBe(
      readMigrations(tenantMigrationDirs).at(-1)?.name,
    );
  });
});
