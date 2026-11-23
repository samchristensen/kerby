import { createControlDb, migrate, readMigrations } from "@kerby/db";
import { createTestDatabase } from "@kerby/db/testing";
import {
  createOpener,
  createSealer,
  createSecretBox,
  generateBoxKey,
  generateSecretsKeyPair,
  SecretsError,
} from "@kerby/secrets";
import { describe, expect, it } from "vitest";
import {
  archiveIntegration,
  audit,
  authenticateApiKey,
  authenticateConsoleSession,
  controlMigrationsDir,
  createApiKey,
  createConsoleSession,
  createIntegration,
  deleteConsoleSession,
  deleteModelKey,
  EmailTakenError,
  findConsoleUser,
  findIntegrationByName,
  getIntegration,
  getTenant,
  hasModelKey,
  IntegrationNameTakenError,
  IntegrationNotFoundError,
  insertConsoleUser,
  insertTenant,
  listApiKeys,
  listIntegrations,
  listModelKeys,
  listTenants,
  listTenantsWithoutDbPassword,
  MAX_MODEL_KEYS_PER_TENANT,
  ModelKeyLimitError,
  newTenantDbPassword,
  parseApiKey,
  putModelKey,
  readConsoleSession,
  readModelKey,
  readTenantDbPassword,
  recordUsage,
  resealTenantDbPasswords,
  resolveTenantDbUrl,
  revokeApiKey,
  setRolePassword,
  setTenantStatus,
  storeTenantDbPassword,
  TenantNameTakenError,
  updateIntegration,
} from "./index.ts";
import { createTestControlDb } from "./testing.ts";

const newTenant = (name: string) => ({ name, dbHost: "db.local", dbPort: 5432 });

type Queryable = Parameters<typeof createApiKey>[0];

/** A key in the tenant's `default` admin integration, made on first use. */
async function keyFor(db: Queryable, tenantId: string, label?: string) {
  const integration =
    (await findIntegrationByName(db, tenantId, "default")) ??
    (await createIntegration(db, { tenantId, name: "default", role: "admin" }));
  return createApiKey(db, tenantId, integration.id, label);
}

describe("tenants", () => {
  it("inserts in provisioning state with names derived from the id, and refuses a duplicate name", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    expect(tenant.status).toBe("provisioning");
    expect(tenant.dbName).toBe(`t_${tenant.id.replaceAll("-", "")}`);
    expect(tenant.dbRole).toBe(`r_${tenant.id.replaceAll("-", "")}`);
    await expect(insertTenant(control.db, newTenant("acme"))).rejects.toBeInstanceOf(
      TenantNameTakenError,
    );
    expect((await getTenant(control.db, tenant.id))?.name).toBe("acme");
    expect(await getTenant(control.db, "not-a-uuid")).toBeUndefined();
  });

  it("filters by status", async () => {
    await using control = await createTestControlDb();
    const a = await insertTenant(control.db, newTenant("a"));
    await insertTenant(control.db, newTenant("b"));
    await setTenantStatus(control.db, a.id, "active");
    expect((await listTenants(control.db, { status: "active" })).map((t) => t.name)).toEqual(["a"]);
    expect(await listTenants(control.db)).toHaveLength(2);
  });
});

describe("tenant database passwords", () => {
  it("are random, stored sealed, and resolve to the tenant's own URL as its own role", async () => {
    await using control = await createTestControlDb();
    const box = createSecretBox([generateBoxKey()]);
    const tenant = await insertTenant(control.db, { name: "acme", dbHost: "h", dbPort: 6543 });
    const password = newTenantDbPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newTenantDbPassword()).not.toBe(password);

    expect(await listTenantsWithoutDbPassword(control.db)).toHaveLength(1);
    await expect(resolveTenantDbUrl(control.db, box, tenant.id)).rejects.toThrow(
      /no stored database password. Fix: start the control service/,
    );
    expect(await storeTenantDbPassword(control.db, box, tenant.id, password)).toBe(true);
    expect(await listTenantsWithoutDbPassword(control.db)).toEqual([]);
    const { rows } = await control.db.query<{ ciphertext: Buffer }>(
      "select ciphertext from tenant_db_credentials",
    );
    expect(rows[0]?.ciphertext.includes(Buffer.from(password))).toBe(false);

    const url = new URL(await resolveTenantDbUrl(control.db, box, tenant.id, "verify-full"));
    expect(url.username).toBe(tenant.dbRole);
    expect(url.password).toBe(password);
    expect(url.host).toBe("h:6543");
    expect(url.pathname).toBe(`/${tenant.dbName}`);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    await expect(resolveTenantDbUrl(control.db, box, crypto.randomUUID())).rejects.toThrow(
      /does not exist/,
    );

    // `ifAbsent` keeps what is stored; a plain store replaces it.
    expect(
      await storeTenantDbPassword(control.db, box, tenant.id, "other", { ifAbsent: true }),
    ).toBe(false);
    expect(await readTenantDbPassword(control.db, box, tenant.id)).toBe(password);
    expect(await storeTenantDbPassword(control.db, box, tenant.id, "rotated")).toBe(true);
    expect(await readTenantDbPassword(control.db, box, tenant.id)).toBe("rotated");
  });

  it("refuses a ciphertext moved to another tenant's row", async () => {
    await using control = await createTestControlDb();
    const box = createSecretBox([generateBoxKey()]);
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));
    await storeTenantDbPassword(control.db, box, a.id, "a-password");
    await storeTenantDbPassword(control.db, box, b.id, "b-password");
    await control.db.query(
      "update tenant_db_credentials set ciphertext = (select ciphertext from tenant_db_credentials where tenant_id = $1) where tenant_id = $2",
      [a.id, b.id],
    );
    await expect(resolveTenantDbUrl(control.db, box, b.id)).rejects.toThrow(
      /does not open with TENANT_DB_KEYS/,
    );
    await expect(readTenantDbPassword(control.db, box, b.id)).rejects.toThrow(
      /does not open with TENANT_DB_KEYS/,
    );
    expect(await readTenantDbPassword(control.db, box, a.id)).toBe("a-password");
  });

  it("re-seals what an older key sealed, once, so that key can be dropped", async () => {
    await using control = await createTestControlDb();
    const oldKey = generateBoxKey();
    const newKey = generateBoxKey();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    await storeTenantDbPassword(control.db, createSecretBox([oldKey]), tenant.id, "pw");
    const rotating = createSecretBox([newKey, oldKey]);
    expect(await resealTenantDbPasswords(control.db, rotating)).toBe(1);
    expect(await resealTenantDbPasswords(control.db, rotating)).toBe(0);
    expect(await readTenantDbPassword(control.db, createSecretBox([newKey]), tenant.id)).toBe("pw");
    // A key list that opens nothing stored stops the re-seal with the fix.
    await expect(
      resealTenantDbPasswords(control.db, createSecretBox([generateBoxKey()])),
    ).rejects.toThrow(/delete the tenant's row from tenant_db_credentials and restart control/);
  });
});

describe("api keys", () => {
  it("authenticates the key it created, to its tenant, and records use", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { key, secret } = await keyFor(control.db, tenant.id, "ci");
    expect(secret).toMatch(/^kb_[0-9a-f]{12}_/);
    expect(parseApiKey(secret)?.id).toBe(key.id);
    const found = await authenticateApiKey(control.db, secret);
    expect(found?.tenant.id).toBe(tenant.id);
    expect(found?.keyId).toBe(key.id);
    expect((await listApiKeys(control.db, tenant.id))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("never stores the secret", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { secret } = await keyFor(control.db, tenant.id);
    const dump = JSON.stringify((await control.db.query("select * from api_keys")).rows);
    expect(dump).not.toContain(secret.slice(-20));
  });

  it("refuses a wrong secret, a malformed key, an unknown id, and a revoked key", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { key, secret } = await keyFor(control.db, tenant.id);
    const wrongSecret = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    expect(await authenticateApiKey(control.db, wrongSecret)).toBeUndefined();
    expect(await authenticateApiKey(control.db, "garbage")).toBeUndefined();
    expect(
      await authenticateApiKey(control.db, `kb_000000000000_${"A".repeat(43)}`),
    ).toBeUndefined();
    expect(await revokeApiKey(control.db, tenant.id, key.id)).toBe(true);
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    expect(await revokeApiKey(control.db, tenant.id, key.id)).toBe(false);
  });

  it("does not let one tenant revoke another's key", async () => {
    await using control = await createTestControlDb();
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));
    const { key, secret } = await keyFor(control.db, a.id);
    expect(await revokeApiKey(control.db, b.id, key.id)).toBe(false);
    expect((await authenticateApiKey(control.db, secret))?.tenant.id).toBe(a.id);
  });
});

describe("integrations", () => {
  it("creates, lists live ones by name, renames, changes role, and frees an archived name", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const zed = await createIntegration(control.db, {
      tenantId: tenant.id,
      name: "zed",
      role: "admin",
    });
    const bots = await createIntegration(control.db, {
      tenantId: tenant.id,
      name: "bots",
      role: "restricted",
    });
    expect((await listIntegrations(control.db, tenant.id)).map((i) => i.name)).toEqual([
      "bots",
      "zed",
    ]);
    await expect(
      createIntegration(control.db, { tenantId: tenant.id, name: "bots", role: "admin" }),
    ).rejects.toBeInstanceOf(IntegrationNameTakenError);
    await expect(
      updateIntegration(control.db, tenant.id, zed.id, { name: "bots" }),
    ).rejects.toBeInstanceOf(IntegrationNameTakenError);
    const changed = await updateIntegration(control.db, tenant.id, bots.id, { role: "admin" });
    expect(changed).toMatchObject({ name: "bots", role: "admin" });
    expect(await getIntegration(control.db, tenant.id, "not-a-uuid")).toBeUndefined();
    expect(await archiveIntegration(control.db, tenant.id, bots.id)).toBe(true);
    expect(await archiveIntegration(control.db, tenant.id, bots.id)).toBe(false);
    expect(await getIntegration(control.db, tenant.id, bots.id)).toBeUndefined();
    expect(
      await updateIntegration(control.db, tenant.id, bots.id, { role: "restricted" }),
    ).toBeUndefined();
    expect(
      (await createIntegration(control.db, { tenantId: tenant.id, name: "bots", role: "admin" }))
        .name,
    ).toBe("bots");
  });

  it("never touches another tenant's integration", async () => {
    await using control = await createTestControlDb();
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));
    const ai = await createIntegration(control.db, { tenantId: a.id, name: "x", role: "admin" });
    expect(await getIntegration(control.db, b.id, ai.id)).toBeUndefined();
    expect(await findIntegrationByName(control.db, b.id, "x")).toBeUndefined();
    expect(
      await updateIntegration(control.db, b.id, ai.id, { role: "restricted" }),
    ).toBeUndefined();
    expect(await archiveIntegration(control.db, b.id, ai.id)).toBe(false);
    await expect(createApiKey(control.db, b.id, ai.id)).rejects.toBeInstanceOf(
      IntegrationNotFoundError,
    );
    // and the schema refuses it too, whatever the query
    await expect(
      control.db.query(
        "insert into api_keys (id, tenant_id, integration_id, key_hash) values ('000000000001', $1, $2, '\\x00')",
        [b.id, ai.id],
      ),
    ).rejects.toThrow(/api_keys_integration_fk/);
  });

  it("authenticates with the integration's role; archiving revokes its keys and refuses new ones", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const bots = await createIntegration(control.db, {
      tenantId: tenant.id,
      name: "bots",
      role: "restricted",
    });
    const { key, secret } = await createApiKey(control.db, tenant.id, bots.id, "ci");
    expect(key.integrationId).toBe(bots.id);
    expect((await authenticateApiKey(control.db, secret))?.integration).toEqual({
      id: bots.id,
      name: "bots",
      role: "restricted",
    });
    await updateIntegration(control.db, tenant.id, bots.id, { role: "admin" });
    expect((await authenticateApiKey(control.db, secret))?.integration.role).toBe("admin");
    expect(await archiveIntegration(control.db, tenant.id, bots.id)).toBe(true);
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    expect((await listApiKeys(control.db, tenant.id))[0]?.revokedAt).toBeInstanceOf(Date);
    await expect(createApiKey(control.db, tenant.id, bots.id)).rejects.toBeInstanceOf(
      IntegrationNotFoundError,
    );
  });

  it("migration 0008 puts every existing key into an admin `default` integration of its tenant", async () => {
    const database = await createTestDatabase();
    const db = createControlDb(database.url, { max: 1 });
    try {
      const before = readMigrations([controlMigrationsDir]).filter(
        (m) => m.name < "control-plane/0008",
      );
      expect(before.map((m) => m.name)).toContain("control-plane/0007_signup_allowlist.sql");
      await db.query(
        "create table schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const m of before) {
        await db.query(m.sql);
        await db.query("insert into schema_migrations (name) values ($1)", [m.name]);
      }
      const ids: string[] = [];
      for (const name of ["a", "b"]) {
        const { rows } = await db.query<{ id: string }>(
          "insert into tenants (name, db_host, db_port, db_name, db_role) values ($1, 'h', 1, $1, $1) returning id",
          [name],
        );
        ids.push(rows[0]?.id ?? "");
      }
      await db.query(
        "insert into api_keys (id, tenant_id, key_hash) values ('aaaaaaaaaaa1', $1, '\\x00'), ('aaaaaaaaaaa2', $1, '\\x00'), ('bbbbbbbbbbb1', $2, '\\x00')",
        ids,
      );
      expect(await migrate(db, [controlMigrationsDir])).toContain(
        "control-plane/0008_integrations.sql",
      );
      for (const [index, tenantId] of ids.entries()) {
        const integrations = await listIntegrations(db, tenantId);
        expect(integrations).toMatchObject([{ name: "default", role: "admin" }]);
        const keys = await listApiKeys(db, tenantId);
        expect(keys).toHaveLength(index === 0 ? 2 : 1);
        expect(keys.every((k) => k.integrationId === integrations[0]?.id)).toBe(true);
      }
    } finally {
      await db.close();
      await database.drop();
    }
  });
});

/** A handle on the control database as one of the limited service roles, given a password the way control does. */
async function asRole(controlUrl: string, role: "kerby_app" | "kerby_console") {
  const admin = createControlDb(controlUrl, { max: 1 });
  await setRolePassword(admin, role, `${role}-password-for-tests`);
  await admin.close();
  const url = new URL(controlUrl);
  url.username = role;
  url.password = `${role}-password-for-tests`;
  return createControlDb(url.toString(), { max: 1 });
}

describe("the limited app role (what api and worker connect as)", () => {
  it("does what the services need and nothing of the operator's", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, { name: "acme", dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, tenant.id, "active");
    const { secret } = await keyFor(control.db, tenant.id);
    const box = createSecretBox([generateBoxKey()]);
    await storeTenantDbPassword(control.db, box, tenant.id, "tenant-db-password");
    const app = await asRole(control.url, "kerby_app");
    try {
      // api: verify a key; worker: list and read tenants, record usage
      expect((await authenticateApiKey(app, secret))?.tenant.id).toBe(tenant.id);
      expect((await listTenants(app, { status: "active" })).map((t) => t.name)).toEqual(["acme"]);
      expect(await getTenant(app, tenant.id)).toBeDefined();
      expect(
        await recordUsage(app, {
          tenantId: tenant.id,
          dedupeKey: "k",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
        }),
      ).toBe(true);
      await app.query("select pg_notify('tenant_work', 'x')");
      // api and worker: open the tenant's database with its stored password
      expect(new URL(await resolveTenantDbUrl(app, box, tenant.id)).password).toBe(
        "tenant-db-password",
      );

      // operator-only data and writes are refused
      for (const sql of [
        "select * from audit_log",
        "insert into tenants (name, db_host, db_port, db_name, db_role) values ('x', 'h', 1, 'd', 'r')",
        "update tenants set status = 'suspended'",
        "update api_keys set revoked_at = null",
        "update integrations set role = 'admin'",
        "insert into integrations (tenant_id, name, role) select id, 'x', 'admin' from tenants",
        "update api_keys set key_hash = '\\x00'",
        "delete from usage",
        "update audit_log set actor = 'x'",
        "delete from audit_log",
        "update tenant_db_credentials set ciphertext = '\\x00'",
        "delete from tenant_db_credentials",
      ]) {
        await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      await app.close();
    }
  });
});

describe("the console role", () => {
  it("does what the console needs, never reads a key hash, and touches nothing of the operator's", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    await setTenantStatus(control.db, tenant.id, "active");
    const user = await insertConsoleUser(control.db, {
      tenantId: tenant.id,
      email: "ada@example.com",
      passwordHash: "scrypt$17$8$1$c2FsdA==$aGFzaA==",
    });
    const sealer = createSealer(generateSecretsKeyPair().publicKey);
    const role = await asRole(control.url, "kerby_console");
    try {
      // sign in: read the person, keep a session
      expect((await findConsoleUser(role, "ada@example.com"))?.id).toBe(user.id);
      const token = await createConsoleSession(
        role,
        { id: user.id, tenantId: tenant.id },
        new Date(Date.now() + 60_000),
      );
      expect((await readConsoleSession(role, token))?.tenantName).toBe("acme");
      await deleteConsoleSession(role, token);
      // keys: create, list, revoke; the new key works at the api
      const { key, secret } = await keyFor(role, tenant.id, "ci");
      expect((await listApiKeys(role, tenant.id)).map((k) => k.label)).toEqual(["ci"]);
      expect((await authenticateApiKey(control.db, secret))?.tenant.id).toBe(tenant.id);
      expect(await revokeApiKey(role, tenant.id, key.id)).toBe(true);
      // integrations: create, rename, change role, archive
      const bots = await createIntegration(role, {
        tenantId: tenant.id,
        name: "bots",
        role: "restricted",
      });
      expect(
        (await updateIntegration(role, tenant.id, bots.id, { name: "robots", role: "admin" }))
          ?.role,
      ).toBe("admin");
      expect(await archiveIntegration(role, tenant.id, bots.id)).toBe(true);
      // model keys, and the audit trail of both
      await putModelKey(role, sealer, tenant.id, "anthropic", "sk-test-1234");
      expect((await listModelKeys(role, tenant.id)).map((k) => k.provider)).toEqual(["anthropic"]);
      expect(await deleteModelKey(role, tenant.id, "anthropic")).toBe(true);
      await audit(role, { tenantId: tenant.id, actor: `user:${user.id}`, action: "key.create" });

      for (const sql of [
        "select key_hash from api_keys",
        "update api_keys set key_hash = '\\x00'",
        "update api_keys set tenant_id = gen_random_uuid()",
        "update api_keys set integration_id = gen_random_uuid()",
        "update integrations set tenant_id = gen_random_uuid()",
        "delete from integrations",
        "insert into console_users (tenant_id, email, password_hash) values (gen_random_uuid(), 'x', 'y')",
        "update console_users set password_hash = 'x'",
        "update console_users set tenant_id = gen_random_uuid()",
        "insert into tenants (name, db_host, db_port, db_name, db_role) values ('x', 'h', 1, 'd', 'r')",
        "update tenants set status = 'active'",
        "select * from audit_log",
        "select * from usage",
        "select * from tenant_db_credentials",
      ]) {
        await expect(role.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      await role.close();
    }
  });
});

describe("console people and sessions", () => {
  const hash = "scrypt$17$8$1$c2FsdA==$aGFzaA==";

  it("keeps one account per email", async () => {
    await using control = await createTestControlDb();
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));
    await insertConsoleUser(control.db, {
      tenantId: a.id,
      email: "ada@example.com",
      passwordHash: hash,
    });
    await expect(
      insertConsoleUser(control.db, {
        tenantId: b.id,
        email: "ada@example.com",
        passwordHash: hash,
      }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    expect(await findConsoleUser(control.db, "bob@example.com")).toBeUndefined();
  });

  it("reads a live session by its token only, never an expired, deleted or malformed one", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { id } = await insertConsoleUser(control.db, {
      tenantId: tenant.id,
      email: "ada@example.com",
      passwordHash: hash,
    });
    const user = { id, tenantId: tenant.id };
    const live = await createConsoleSession(control.db, user, new Date(Date.now() + 60_000));
    const expired = await createConsoleSession(control.db, user, new Date(Date.now() - 1));

    expect(await readConsoleSession(control.db, live)).toMatchObject({
      userId: id,
      email: "ada@example.com",
      tenantId: tenant.id,
      tenantName: "acme",
      tenantStatus: "provisioning",
    });
    expect(await readConsoleSession(control.db, expired)).toBeUndefined();
    const altered = `${live.slice(0, -1)}${live.endsWith("A") ? "B" : "A"}`;
    expect(await readConsoleSession(control.db, altered)).toBeUndefined();
    expect(await readConsoleSession(control.db, "not a token")).toBeUndefined();
    // the table holds hashes, not tokens
    const stored = await control.db.query("select 1 from console_sessions where token_hash = $1", [
      Buffer.from(live),
    ]);
    expect(stored.rowCount).toBe(0);

    // a new sign-in forgets the person's expired sessions
    await createConsoleSession(control.db, user, new Date(Date.now() + 60_000));
    const { rows } = await control.db.query<{ n: number }>(
      "select count(*)::int as n from console_sessions where expires_at <= now()",
    );
    expect(rows[0]?.n).toBe(0);

    await deleteConsoleSession(control.db, live);
    expect(await readConsoleSession(control.db, live)).toBeUndefined();
  });

  it("lets the api resolve a session to its tenant as kerby_app, never the person, and nothing else of sessions", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { id } = await insertConsoleUser(control.db, {
      tenantId: tenant.id,
      email: "ada@example.com",
      passwordHash: hash,
    });
    const user = { id, tenantId: tenant.id };
    const live = await createConsoleSession(control.db, user, new Date(Date.now() + 60_000));
    const expired = await createConsoleSession(control.db, user, new Date(Date.now() - 1));
    const app = await asRole(control.url, "kerby_app");
    try {
      const found = await authenticateConsoleSession(app, live);
      expect(found?.userId).toBe(id);
      expect(found?.tenant.id).toBe(tenant.id);
      expect(await authenticateConsoleSession(app, expired)).toBeUndefined();
      expect(await authenticateConsoleSession(app, "not a token")).toBeUndefined();
      const altered = `${live.slice(0, -1)}${live.endsWith("A") ? "B" : "A"}`;
      expect(await authenticateConsoleSession(app, altered)).toBeUndefined();
      for (const sql of [
        "select * from console_users",
        "delete from console_sessions",
        "update console_sessions set expires_at = now() + interval '1 year'",
        "insert into console_sessions (token_hash, tenant_id, user_id, expires_at) values ('\\x00', gen_random_uuid(), gen_random_uuid(), now())",
      ]) {
        await expect(app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    } finally {
      await app.close();
    }
  });
});

describe("model keys", () => {
  it("seals per tenant, replaces, lists providers without keys, and deletes", async () => {
    await using control = await createTestControlDb();
    const pair = generateSecretsKeyPair();
    const sealer = createSealer(pair.publicKey);
    const opener = createOpener([pair.privateKey]);
    const a = await insertTenant(control.db, newTenant("a"));
    const b = await insertTenant(control.db, newTenant("b"));

    await putModelKey(control.db, sealer, a.id, "anthropic", "sk-a-1");
    await putModelKey(control.db, sealer, a.id, "anthropic", "sk-a-2");
    await putModelKey(control.db, sealer, b.id, "anthropic", "sk-b");

    expect(await readModelKey(control.db, opener, a.id, "anthropic")).toBe("sk-a-2");
    expect(await readModelKey(control.db, opener, b.id, "anthropic")).toBe("sk-b");
    expect(await readModelKey(control.db, opener, a.id, "openai")).toBeUndefined();
    expect((await listModelKeys(control.db, a.id)).map((k) => k.provider)).toEqual(["anthropic"]);
    const raw = await control.db.query<{ ciphertext: Buffer }>(
      "select ciphertext from tenant_secrets where tenant_id = $1",
      [a.id],
    );
    expect(raw.rows[0]?.ciphertext.includes(Buffer.from("sk-a-2"))).toBe(false);

    // a ciphertext copied into another tenant's row does not open there
    await control.db.query(
      `update tenant_secrets set ciphertext = (select ciphertext from tenant_secrets where tenant_id = $1)
        where tenant_id = $2`,
      [a.id, b.id],
    );
    await expect(readModelKey(control.db, opener, b.id, "anthropic")).rejects.toBeInstanceOf(
      SecretsError,
    );
    expect(await deleteModelKey(control.db, b.id, "anthropic")).toBe(true);
    expect(await hasModelKey(control.db, b.id, "anthropic")).toBe(false);
    expect(await deleteModelKey(control.db, b.id, "anthropic")).toBe(false);
  });

  it("refuses an invalid provider id and a tenant past the key limit", async () => {
    await using control = await createTestControlDb();
    const sealer = createSealer(generateSecretsKeyPair().publicKey);
    const tenant = await insertTenant(control.db, newTenant("a"));
    await expect(putModelKey(control.db, sealer, tenant.id, "../x", "k")).rejects.toThrow(
      /provider id/,
    );
    for (let i = 0; i < MAX_MODEL_KEYS_PER_TENANT; i++) {
      await putModelKey(control.db, sealer, tenant.id, `p${i}`, "k");
    }
    await expect(
      putModelKey(control.db, sealer, tenant.id, "one-more", "k"),
    ).rejects.toBeInstanceOf(ModelKeyLimitError);
    // replacing an existing one still works at the limit
    await putModelKey(control.db, sealer, tenant.id, "p0", "k2");
  });
});
