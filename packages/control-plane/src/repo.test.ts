import { randomUUID } from "node:crypto";
import type { ControlDb } from "@kerby/db";
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
  ApiKeyLimitError,
  audit,
  authenticateApiKey,
  authenticateConsoleSession,
  createApiKey,
  createConsoleSession,
  createIntegration,
  deleteConsoleSession,
  deleteIntegration,
  deleteModelKey,
  deleteSubscription,
  disableSubscription,
  EmailTakenError,
  ensureDefaultIntegration,
  findConsoleUser,
  getTenant,
  hasModelKey,
  hintTenantWork,
  insertConsoleUser,
  insertSubscription,
  insertTenant,
  listApiKeys,
  listDeliverableSubscriptions,
  listDueTenants,
  listIntegrations,
  listModelKeys,
  listSubscriptions,
  listTenants,
  listTenantsWithoutDbPassword,
  listTenantsWithSubscriptions,
  MAX_API_KEYS_PER_TENANT,
  MAX_MODEL_KEYS_PER_TENANT,
  ModelKeyLimitError,
  newTenantDbPassword,
  openSubscriptionForDelivery,
  parseApiKey,
  putModelKey,
  readConsoleSession,
  readModelKey,
  readTenantDbPassword,
  readWakeupVersion,
  recordDeliveryFailure,
  recordDeliverySuccess,
  recordUsage,
  resealTenantDbPasswords,
  resolveTenantDbUrl,
  revokeApiKey,
  rotateSubscriptionSecret,
  setIntegrationScopes,
  setTenantStatus,
  settleTenantWakeup,
  storeTenantDbPassword,
  TenantNameTakenError,
  updateSubscription,
} from "./index.ts";
import { asServiceRole, createTestControlDb } from "./testing.ts";

const newTenant = (name: string) => ({ name, dbHost: "db.local", dbPort: 5432 });
const newSubscription = (tenantId: string, integrationId: string) => ({
  tenantId,
  integrationId,
  destination: { kind: "webhook" as const, url: "https://example.com/hook" },
  types: ["*" as const],
  scope: "own" as const,
  description: "",
  secret: "whsec-test",
});

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
    const integration = await ensureDefaultIntegration(control.db, tenant.id);
    const { key, secret } = await createApiKey(control.db, tenant.id, integration.id, "ci");
    expect(secret).toMatch(/^kb_[0-9a-f]{12}_/);
    expect(parseApiKey(secret)?.id).toBe(key.id);
    const found = await authenticateApiKey(control.db, secret);
    expect(found?.tenant.id).toBe(tenant.id);
    expect(found?.keyId).toBe(key.id);
    expect(found?.integration).toEqual(integration);
    expect((await listApiKeys(control.db, tenant.id))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("never stores the secret", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { secret } = await createApiKey(
      control.db,
      tenant.id,
      (await ensureDefaultIntegration(control.db, tenant.id)).id,
    );
    const dump = JSON.stringify((await control.db.query("select * from api_keys")).rows);
    expect(dump).not.toContain(secret.slice(-20));
  });

  it("refuses a wrong secret, a malformed key, an unknown id, and a revoked key", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const { key, secret } = await createApiKey(
      control.db,
      tenant.id,
      (await ensureDefaultIntegration(control.db, tenant.id)).id,
    );
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
    const { key, secret } = await createApiKey(
      control.db,
      a.id,
      (await ensureDefaultIntegration(control.db, a.id)).id,
    );
    expect(await revokeApiKey(control.db, b.id, key.id)).toBe(false);
    expect((await authenticateApiKey(control.db, secret))?.tenant.id).toBe(a.id);
  });

  it("caps a tenant's live keys, even created at once, and a key revoked in the same transaction frees its place", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, newTenant("acme"));
    const other = await insertTenant(control.db, newTenant("other"));
    const mine = await ensureDefaultIntegration(control.db, tenant.id);
    const theirs = await ensureDefaultIntegration(control.db, other.id);
    const settled = await Promise.allSettled(
      Array.from({ length: MAX_API_KEYS_PER_TENANT + 5 }, () =>
        createApiKey(control.db, tenant.id, mine.id),
      ),
    );
    const refused = settled.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(5);
    for (const result of refused) expect(result.reason).toBeInstanceOf(ApiKeyLimitError);
    const live = await listApiKeys(control.db, tenant.id);
    expect(live).toHaveLength(MAX_API_KEYS_PER_TENANT);
    // Another tenant's cap is its own.
    await createApiKey(control.db, other.id, theirs.id);

    // Rotation at the cap: revoke and create in one transaction.
    const oldest = live[0] ?? expect.fail("no key");
    const rotated = await control.db.transaction(async (tx) => {
      expect(await revokeApiKey(tx, tenant.id, oldest.id)).toBe(true);
      return createApiKey(tx, tenant.id, mine.id, "rotated");
    });
    expect((await authenticateApiKey(control.db, rotated.secret))?.tenant.id).toBe(tenant.id);
    await expect(createApiKey(control.db, tenant.id, mine.id)).rejects.toBeInstanceOf(
      ApiKeyLimitError,
    );
    // A revoked key no longer counts.
    expect(await revokeApiKey(control.db, tenant.id, rotated.key.id)).toBe(true);
    await createApiKey(control.db, tenant.id, mine.id);
  });
});

describe("tenant wakeups", () => {
  const active = async (db: ControlDb, name: string) => {
    const tenant = await insertTenant(db, newTenant(name));
    await setTenantStatus(db, tenant.id, "active");
    return tenant;
  };
  /** Sorted: two hints in the same instant have no order. */
  const dueNames = async (db: ControlDb) => (await listDueTenants(db)).map((t) => t.name).sort();

  it("lists active tenants that were hinted, until a worker settles them", async () => {
    await using control = await createTestControlDb();
    const a = await active(control.db, "a");
    const b = await active(control.db, "b");
    const suspended = await active(control.db, "s");
    expect(await dueNames(control.db)).toEqual([]);
    await hintTenantWork(control.db, a.id);
    await hintTenantWork(control.db, b.id);
    await hintTenantWork(control.db, suspended.id);
    await setTenantStatus(control.db, suspended.id, "suspended");
    expect(await dueNames(control.db)).toEqual(["a", "b"]);

    const version = await readWakeupVersion(control.db, a.id);
    expect(await settleTenantWakeup(control.db, a.id, version, null)).toBe(true);
    expect(await dueNames(control.db)).toEqual(["b"]);
    // A due time in the future is not due yet; one in the past is.
    const bVersion = await readWakeupVersion(control.db, b.id);
    await settleTenantWakeup(control.db, b.id, bVersion, new Date(Date.now() + 60_000));
    expect(await dueNames(control.db)).toEqual([]);
    await settleTenantWakeup(control.db, b.id, bVersion, new Date(Date.now() - 1000));
    expect(await dueNames(control.db)).toEqual(["b"]);
  });

  it("never lets a settle overwrite a hint that arrived after its version was read", async () => {
    await using control = await createTestControlDb();
    const a = await active(control.db, "a");
    await hintTenantWork(control.db, a.id);
    const before = await readWakeupVersion(control.db, a.id);
    await hintTenantWork(control.db, a.id); // arrives while the worker claims
    expect(await settleTenantWakeup(control.db, a.id, before, null)).toBe(false);
    expect(await dueNames(control.db)).toEqual(["a"]);
  });

  it("settles a tenant with no hint yet, and a hint racing that first settle still wins", async () => {
    await using control = await createTestControlDb();
    const a = await active(control.db, "a");
    const b = await active(control.db, "b");
    expect(await readWakeupVersion(control.db, a.id)).toBe("0");
    expect(await settleTenantWakeup(control.db, a.id, "0", new Date(Date.now() - 1000))).toBe(true);
    expect(await dueNames(control.db)).toEqual(["a"]);

    const none = await readWakeupVersion(control.db, b.id);
    await hintTenantWork(control.db, b.id);
    expect(await settleTenantWakeup(control.db, b.id, none, null)).toBe(false);
    expect(await dueNames(control.db)).toEqual(["a", "b"]);
  });

  it("treats an id that is not a uuid as no tenant", async () => {
    await using control = await createTestControlDb();
    await hintTenantWork(control.db, "not-a-uuid");
    expect(await readWakeupVersion(control.db, "not-a-uuid")).toBe("0");
    expect(await settleTenantWakeup(control.db, "not-a-uuid", "0", null)).toBe(false);
  });
});

describe("the limited app role (what api and worker connect as)", () => {
  it("does what the services need and nothing of the operator's", async () => {
    await using control = await createTestControlDb();
    const tenant = await insertTenant(control.db, { name: "acme", dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, tenant.id, "active");
    const integration = await ensureDefaultIntegration(control.db, tenant.id);
    const { secret } = await createApiKey(control.db, tenant.id, integration.id);
    const box = createSecretBox([generateBoxKey()]);
    await storeTenantDbPassword(control.db, box, tenant.id, "tenant-db-password");
    const app = await asServiceRole(control.url, "kerby_app");
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
      // api: hint a tenant's work and ring the doorbell; worker: list due tenants, read and settle the hint
      await hintTenantWork(app, tenant.id);
      expect((await listDueTenants(app)).map((t) => t.name)).toEqual(["acme"]);
      const version = await readWakeupVersion(app, tenant.id);
      expect(await settleTenantWakeup(app, tenant.id, version, null)).toBe(true);
      expect(await listDueTenants(app)).toEqual([]);
      // api and worker: open the tenant's database with its stored password
      expect(new URL(await resolveTenantDbUrl(app, box, tenant.id)).password).toBe(
        "tenant-db-password",
      );
      // api: manage subscriptions; dispatcher: find, open and deliver to them, record their health
      const keys = generateSecretsKeyPair();
      const id = randomUUID();
      await insertSubscription(
        app,
        createSealer(keys.publicKey),
        { ...newSubscription(tenant.id, integration.id), id },
        10,
      );
      expect(await listSubscriptions(app, tenant.id)).toHaveLength(1);
      expect(await updateSubscription(app, tenant.id, id, { description: "x" })).toBeDefined();
      expect(
        await rotateSubscriptionSecret(
          app,
          createSealer(keys.publicKey),
          tenant.id,
          id,
          "s2",
          1000,
        ),
      ).toBeDefined();
      expect(await listTenantsWithSubscriptions(app)).toEqual([tenant.id]);
      expect(await listDeliverableSubscriptions(app, tenant.id)).toHaveLength(1);
      const opened = await openSubscriptionForDelivery(
        app,
        createOpener([keys.privateKey]),
        tenant.id,
        id,
      );
      expect(opened?.secrets).toEqual(["s2", "whsec-test"]);
      expect(await recordDeliveryFailure(app, id, 60_000)).toBe(false);
      await recordDeliverySuccess(app, id);
      await disableSubscription(app, id, "gone");
      await app.query("select pg_notify('tenant_events', 'x')");
      expect(await deleteSubscription(app, tenant.id, id)).toBe(true);

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
        "delete from tenant_wakeups",
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
    const role = await asServiceRole(control.url, "kerby_console");
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
      // integrations: make, re-scope; keys: create, list, revoke; the new key works at the api
      const integration = await createIntegration(role, tenant.id, {
        name: "crm",
        scopes: ["conversations"],
      });
      expect(
        (await setIntegrationScopes(role, tenant.id, integration.id, ["events"]))?.scopes,
      ).toEqual(["events"]);
      expect((await listIntegrations(role, tenant.id)).map((i) => i.name)).toEqual(["crm"]);
      const { key, secret } = await createApiKey(role, tenant.id, integration.id, "ci");
      expect((await listApiKeys(role, tenant.id, integration.id)).map((k) => k.label)).toEqual([
        "ci",
      ]);
      expect((await authenticateApiKey(control.db, secret))?.tenant.id).toBe(tenant.id);
      expect(await revokeApiKey(role, tenant.id, key.id)).toBe(true);
      // deleting an integration revokes its keys and deletes its subscriptions
      const { secret: other } = await createApiKey(role, tenant.id, integration.id);
      await insertSubscription(
        control.db,
        sealer,
        { ...newSubscription(tenant.id, integration.id), id: randomUUID() },
        10,
      );
      expect((await role.query("select id from subscriptions")).rowCount).toBe(1);
      expect(await deleteIntegration(role, tenant.id, integration.id)).toBe(true);
      expect(await authenticateApiKey(control.db, other)).toBeUndefined();
      expect(await listSubscriptions(control.db, tenant.id)).toEqual([]);
      // model keys, and the audit trail of both
      await putModelKey(role, sealer, tenant.id, "anthropic", "sk-test-1234");
      expect((await listModelKeys(role, tenant.id)).map((k) => k.provider)).toEqual(["anthropic"]);
      expect(await deleteModelKey(role, tenant.id, "anthropic")).toBe(true);
      await audit(role, { tenantId: tenant.id, actor: `user:${user.id}`, action: "key.create" });

      for (const sql of [
        "select key_hash from api_keys",
        "update api_keys set key_hash = '\\x00'",
        "update api_keys set tenant_id = gen_random_uuid()",
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
    // A minute back, not a millisecond: Postgres's clock (in Docker) may trail the test's.
    const expired = await createConsoleSession(control.db, user, new Date(Date.now() - 60_000));

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
    const expired = await createConsoleSession(control.db, user, new Date(Date.now() - 60_000));
    const app = await asServiceRole(control.url, "kerby_app");
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
