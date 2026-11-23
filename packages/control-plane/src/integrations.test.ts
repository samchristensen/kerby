import { randomUUID } from "node:crypto";
import { SCOPES } from "@kerby/contracts";
import { createControlDb, readMigrations } from "@kerby/db";
import { createTestDatabase } from "@kerby/db/testing";
import { createOpener, createSealer, generateSecretsKeyPair } from "@kerby/secrets";
import { describe, expect, it } from "vitest";
import {
  authenticateApiKey,
  controlMigrationsDir,
  createApiKey,
  createIntegration,
  deleteIntegration,
  deleteSubscription,
  ensureDefaultIntegration,
  getIntegration,
  getSubscription,
  IntegrationNameTakenError,
  insertSubscription,
  insertTenant,
  listApiKeys,
  listIntegrations,
  listSubscriptions,
  listTenantsWithSubscriptions,
  openSubscriptionForDelivery,
  recordDeliveryFailure,
  recordDeliverySuccess,
  rotateSubscriptionSecret,
  SubscriptionLimitError,
  setIntegrationScopes,
  setTenantStatus,
  updateSubscription,
} from "./index.ts";
import { createTestControlDb, type TestControlDb } from "./testing.ts";

const newTenant = (name: string) => ({ name, dbHost: "db.local", dbPort: 5432 });

const keys = generateSecretsKeyPair();
const sealer = createSealer(keys.publicKey);
const opener = createOpener([keys.privateKey]);

const newSubscription = (tenantId: string, integrationId: string, secret = "whsec-one") => ({
  id: randomUUID(),
  tenantId,
  integrationId,
  destination: { kind: "webhook" as const, url: "https://example.com/hook" },
  types: ["turn.*" as const],
  scope: "own" as const,
  description: "crm sync",
  secret,
});

async function tenantWithIntegration(control: TestControlDb, name = "acme") {
  const tenant = await insertTenant(control.db, newTenant(name));
  await setTenantStatus(control.db, tenant.id, "active");
  const integration = await createIntegration(control.db, tenant.id, {
    name: "crm",
    scopes: ["events", "conversations"],
  });
  return { tenant, integration };
}

describe("the integrations migration", () => {
  it("moves every existing key into a default integration holding every scope", async () => {
    const database = await createTestDatabase();
    const db = createControlDb(database.url, { max: 1 });
    try {
      const migrations = readMigrations([controlMigrationsDir]);
      const at = migrations.findIndex((m) => m.name.endsWith("0007_integrations.sql"));
      expect(at).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, at)) await db.query(migration.sql);
      const tenant = await insertTenant(db, newTenant("acme"));
      await db.query("insert into api_keys (id, tenant_id, key_hash) values ('k1', $1, '\\x00')", [
        tenant.id,
      ]);
      for (const migration of migrations.slice(at)) await db.query(migration.sql);

      const [integration] = await listIntegrations(db, tenant.id);
      expect(integration).toMatchObject({ name: "default", scopes: [...SCOPES] });
      expect((await listApiKeys(db, tenant.id)).map((k) => k.integrationId)).toEqual([
        integration?.id,
      ]);
    } finally {
      await db.close();
      await database.drop();
    }
  });
});

describe("integrations", () => {
  it("creates, lists, reads and re-scopes, and refuses a name a live one holds", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    expect(integration.scopes).toEqual(["conversations", "events"]);
    await expect(
      createIntegration(control.db, tenant.id, { name: "crm", scopes: [] }),
    ).rejects.toBeInstanceOf(IntegrationNameTakenError);
    const fallback = await ensureDefaultIntegration(control.db, tenant.id);
    expect(await ensureDefaultIntegration(control.db, tenant.id)).toEqual(fallback);
    expect((await listIntegrations(control.db, tenant.id)).map((i) => i.name)).toEqual([
      "crm",
      "default",
    ]);
    expect(await getIntegration(control.db, tenant.id, integration.id)).toEqual(integration);
    expect(await getIntegration(control.db, tenant.id, "not-a-uuid")).toBeUndefined();
    const rescoped = await setIntegrationScopes(control.db, tenant.id, integration.id, [
      "admin",
      "events",
    ]);
    expect(rescoped?.scopes).toEqual(["events", "admin"]);
    // a deleted integration frees its name
    expect(await deleteIntegration(control.db, tenant.id, integration.id)).toBe(true);
    expect(await deleteIntegration(control.db, tenant.id, integration.id)).toBe(false);
    expect(await getIntegration(control.db, tenant.id, integration.id)).toBeUndefined();
    expect(await setIntegrationScopes(control.db, tenant.id, integration.id, [])).toBeUndefined();
    await createIntegration(control.db, tenant.id, { name: "crm", scopes: [] });
  });

  it("authenticates a key with its integration's current scopes, and refuses it once the integration is deleted", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const { secret } = await createApiKey(control.db, tenant.id, integration.id);
    expect((await authenticateApiKey(control.db, secret))?.integration).toEqual(integration);
    await setIntegrationScopes(control.db, tenant.id, integration.id, ["judgments"]);
    expect((await authenticateApiKey(control.db, secret))?.integration.scopes).toEqual([
      "judgments",
    ]);

    const subscription = await insertSubscription(
      control.db,
      sealer,
      newSubscription(tenant.id, integration.id),
      10,
    );
    await deleteIntegration(control.db, tenant.id, integration.id);
    expect(await authenticateApiKey(control.db, secret)).toBeUndefined();
    expect((await listApiKeys(control.db, tenant.id))[0]?.revokedAt).toBeInstanceOf(Date);
    expect(await getSubscription(control.db, tenant.id, subscription.id)).toBeUndefined();
    await expect(createApiKey(control.db, tenant.id, integration.id)).rejects.toThrow(
      /not a live integration/,
    );
  });

  it("isolates tenants: another tenant's integration is not found and takes no keys", async () => {
    await using control = await createTestControlDb();
    const a = await tenantWithIntegration(control, "a");
    const b = await tenantWithIntegration(control, "b");
    expect(await getIntegration(control.db, b.tenant.id, a.integration.id)).toBeUndefined();
    expect(
      await setIntegrationScopes(control.db, b.tenant.id, a.integration.id, ["admin"]),
    ).toBeUndefined();
    expect(await deleteIntegration(control.db, b.tenant.id, a.integration.id)).toBe(false);
    await expect(createApiKey(control.db, b.tenant.id, a.integration.id)).rejects.toThrow(
      /not a live integration/,
    );
    expect(await getIntegration(control.db, a.tenant.id, a.integration.id)).toEqual(a.integration);
  });
});

describe("subscriptions", () => {
  it("seals the secret: the row never holds it in the clear, and delivery opens it", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const input = newSubscription(tenant.id, integration.id, "whsec-super-secret-value");
    const created = await insertSubscription(control.db, sealer, input, 10);
    expect(created).toMatchObject({ state: "active", types: ["turn.*"], scope: "own" });
    const dump = JSON.stringify((await control.db.query("select * from subscriptions")).rows);
    expect(dump).not.toContain("super-secret");
    const rawSecret = (
      await control.db.query<{ secret: Buffer }>("select secret from subscriptions")
    ).rows[0]?.secret;
    expect(rawSecret?.toString("latin1")).not.toContain("super-secret");
    expect(
      (await openSubscriptionForDelivery(control.db, opener, tenant.id, created.id))?.secrets,
    ).toEqual(["whsec-super-secret-value"]);
  });

  it("refuses a subscription beyond the tenant's limit", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    await insertSubscription(control.db, sealer, newSubscription(tenant.id, integration.id), 2);
    await insertSubscription(control.db, sealer, newSubscription(tenant.id, integration.id), 2);
    await expect(
      insertSubscription(control.db, sealer, newSubscription(tenant.id, integration.id), 2),
    ).rejects.toBeInstanceOf(SubscriptionLimitError);
    expect(await listSubscriptions(control.db, tenant.id)).toHaveLength(2);
  });

  it("disables by hand, and re-enabling clears the reason and the failure streak", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const { id } = await insertSubscription(
      control.db,
      sealer,
      newSubscription(tenant.id, integration.id),
      10,
    );
    await recordDeliveryFailure(control.db, id, 3_600_000);
    const disabled = await updateSubscription(control.db, tenant.id, id, { enabled: false });
    expect(disabled).toMatchObject({ state: "disabled", disabledReason: "disabled by hand" });
    expect(disabled?.failingSince).toBeInstanceOf(Date);
    expect(await openSubscriptionForDelivery(control.db, opener, tenant.id, id)).toBeUndefined();
    // a change that does not mention `enabled` leaves the state alone
    expect(
      await updateSubscription(control.db, tenant.id, id, { description: "renamed" }),
    ).toMatchObject({ state: "disabled", description: "renamed" });
    const enabled = await updateSubscription(control.db, tenant.id, id, { enabled: true });
    expect(enabled).toMatchObject({ state: "active", disabledReason: null, failingSince: null });
    expect(await openSubscriptionForDelivery(control.db, opener, tenant.id, id)).toBeDefined();
  });

  it("keeps the previous secret signing after a rotation, until it expires", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const { id } = await insertSubscription(
      control.db,
      sealer,
      newSubscription(tenant.id, integration.id, "old"),
      10,
    );
    const rotated = await rotateSubscriptionSecret(
      control.db,
      sealer,
      tenant.id,
      id,
      "new",
      3_600_000,
    );
    expect(rotated?.previousExpiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect((await openSubscriptionForDelivery(control.db, opener, tenant.id, id))?.secrets).toEqual(
      ["new", "old"],
    );
    await control.db.query(
      "update subscriptions set previous_secret_expires_at = now() - interval '1 second'",
    );
    expect((await openSubscriptionForDelivery(control.db, opener, tenant.id, id))?.secrets).toEqual(
      ["new"],
    );
  });

  it("delivers to nothing once the integration is deleted", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const { id } = await insertSubscription(
      control.db,
      sealer,
      newSubscription(tenant.id, integration.id),
      10,
    );
    // marked deleted without the cascade: delivery must still refuse it
    await control.db.query("update integrations set deleted_at = now() where id = $1", [
      integration.id,
    ]);
    expect(await openSubscriptionForDelivery(control.db, opener, tenant.id, id)).toBeUndefined();
  });

  it("disables a subscription only after every delivery failed for the whole window", async () => {
    await using control = await createTestControlDb();
    const { tenant, integration } = await tenantWithIntegration(control);
    const { id } = await insertSubscription(
      control.db,
      sealer,
      newSubscription(tenant.id, integration.id),
      10,
    );
    const hour = 3_600_000;
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(false);
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(false);
    // a success ends the streak; the next failure starts a new one
    await recordDeliverySuccess(control.db, id);
    expect((await getSubscription(control.db, tenant.id, id))?.failingSince).toBeNull();
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(false);
    await control.db.query(
      "update subscriptions set failing_since = now() - interval '59 minutes' where id = $1",
      [id],
    );
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(false);
    await control.db.query(
      "update subscriptions set failing_since = now() - interval '61 minutes' where id = $1",
      [id],
    );
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(true);
    expect(await getSubscription(control.db, tenant.id, id)).toMatchObject({
      state: "disabled",
      disabledReason: "every delivery failed for 1 hours",
    });
    // already disabled: nothing more to disable
    expect(await recordDeliveryFailure(control.db, id, hour)).toBe(false);
  });

  it("sweeps only active tenants that hold a subscription", async () => {
    await using control = await createTestControlDb();
    const a = await tenantWithIntegration(control, "a");
    const b = await tenantWithIntegration(control, "b");
    await tenantWithIntegration(control, "c");
    await insertSubscription(
      control.db,
      sealer,
      newSubscription(a.tenant.id, a.integration.id),
      10,
    );
    await insertSubscription(
      control.db,
      sealer,
      newSubscription(b.tenant.id, b.integration.id),
      10,
    );
    await setTenantStatus(control.db, b.tenant.id, "suspended");
    expect(await listTenantsWithSubscriptions(control.db)).toEqual([a.tenant.id]);
  });

  it("isolates tenants: another tenant's subscription cannot be read, changed, rotated or deleted", async () => {
    await using control = await createTestControlDb();
    const a = await tenantWithIntegration(control, "a");
    const b = await tenantWithIntegration(control, "b");
    const { id } = await insertSubscription(
      control.db,
      sealer,
      newSubscription(a.tenant.id, a.integration.id),
      10,
    );
    expect(await getSubscription(control.db, b.tenant.id, id)).toBeUndefined();
    expect(
      await updateSubscription(control.db, b.tenant.id, id, { enabled: false }),
    ).toBeUndefined();
    expect(
      await rotateSubscriptionSecret(control.db, sealer, b.tenant.id, id, "x", 1000),
    ).toBeUndefined();
    expect(await deleteSubscription(control.db, b.tenant.id, id)).toBe(false);
    expect(await openSubscriptionForDelivery(control.db, opener, b.tenant.id, id)).toBeUndefined();
    expect(await listSubscriptions(control.db, b.tenant.id)).toEqual([]);
    expect((await getSubscription(control.db, a.tenant.id, id))?.state).toBe("active");
    expect(await deleteSubscription(control.db, a.tenant.id, id)).toBe(true);
  });
});
