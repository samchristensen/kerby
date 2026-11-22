import { createControlDb } from "@kerby/db";
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
  authenticateApiKey,
  createApiKey,
  deleteModelKey,
  getTenant,
  hasModelKey,
  insertTenant,
  listApiKeys,
  listModelKeys,
  listTenants,
  listTenantsWithoutDbPassword,
  MAX_MODEL_KEYS_PER_TENANT,
  ModelKeyLimitError,
  newTenantDbPassword,
  parseApiKey,
  putModelKey,
  readModelKey,
  readTenantDbPassword,
  recordUsage,
  resealTenantDbPasswords,
  resolveTenantDbUrl,
  revokeApiKey,
  setAppRolePassword,
  setTenantStatus,
  storeTenantDbPassword,
  TenantNameTakenError,
} from "./index.ts";
import { createTestControlDb } from "./testing.ts";

const newTenant = (name: string) => ({ name, dbHost: "db.local", dbPort: 5432 });

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
    const { key, secret } = await createApiKey(control.db, tenant.id, "ci");
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
    const { secret } = await createApiKey(control.db, tenant.id);
    const dump = JSON.stringify((await control.db.query("select * from api_keys")).rows);
    expect(dump).not.toContain(secret.slice(-20));
  });

  it("refuses a wrong secret, a malformed key, an unknown id, and a revoked key", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { key, secret } = await createApiKey(control.db, tenant.id);
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
    const { key, secret } = await createApiKey(control.db, a.id);
    expect(await revokeApiKey(control.db, b.id, key.id)).toBe(false);
    expect((await authenticateApiKey(control.db, secret))?.tenant.id).toBe(a.id);
  });
});

describe("the limited app role (what api and worker connect as)", () => {
  async function asApp(controlUrl: string) {
    const admin = createControlDb(controlUrl, { max: 1 });
    await setAppRolePassword(admin, "app-role-password-for-tests");
    await admin.close();
    const url = new URL(controlUrl);
    url.username = "kerby_app";
    url.password = "app-role-password-for-tests";
    return createControlDb(url.toString(), { max: 1 });
  }

  it("does what the services need and nothing of the operator's", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, { name: "acme", dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, tenant.id, "active");
    const { secret } = await createApiKey(control.db, tenant.id);
    const box = createSecretBox([generateBoxKey()]);
    await storeTenantDbPassword(control.db, box, tenant.id, "tenant-db-password");
    const app = await asApp(control.url);
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
