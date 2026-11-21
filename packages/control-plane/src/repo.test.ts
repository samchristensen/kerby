import { describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  createApiKey,
  getTenant,
  insertTenant,
  listApiKeys,
  listTenants,
  parseApiKey,
  revokeApiKey,
  setTenantStatus,
  TenantNameTakenError,
  tenantDbPassword,
  tenantDbUrl,
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

  it("derives a per-tenant database URL from the cluster secret", () => {
    const tenant = {
      id: "11111111-1111-4111-8111-111111111111",
      dbHost: "h",
      dbPort: 6543,
      dbName: "t_x",
      dbRole: "r_x",
    };
    const url = new URL(tenantDbUrl(tenant, "cluster-secret"));
    expect(url.username).toBe("r_x");
    expect(url.password).toBe(tenantDbPassword("cluster-secret", tenant.id));
    expect(url.host).toBe("h:6543");
    expect(url.pathname).toBe("/t_x");
    expect(tenantDbPassword("cluster-secret", tenant.id)).not.toBe(
      tenantDbPassword("cluster-secret", "other"),
    );
    expect(tenantDbPassword("cluster-secret", tenant.id)).not.toBe(
      tenantDbPassword("another-secret", tenant.id),
    );
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
