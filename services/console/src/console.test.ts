import { randomUUID } from "node:crypto";
import {
  authenticateApiKey,
  createApiKey,
  ensureDefaultIntegration,
  insertConsoleUser,
  insertSubscription,
  insertTenant,
  listSubscriptions,
  readModelKey,
  setTenantStatus,
} from "@kerby/control-plane";
import {
  asServiceRole,
  createTestControlDb,
  type TestControlDb,
} from "@kerby/control-plane/testing";
import { createOpener, createSealer, generateSecretsKeyPair } from "@kerby/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleService } from "./service/index.ts";
import { hashPassword, verifyPassword } from "./service/passwords.ts";
import type { ApiClient, ConsoleDeps, ConsoleService, SignupClient } from "./types/index.ts";

const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A cheap scrypt for tests; production uses `PASSWORD_COST`. */
const COST = 10;
const PASSWORD = "correct horse battery";

/**
 * The console as it runs: the service over the control database as the `kerby_console` role. Control's sign-up route
 * is played by `signups`, which writes what control writes (a tenant, its first key, its person) as the admin.
 */
async function harness(
  settings: Partial<ConsoleDeps["settings"]> = {},
  api: ApiClient = () => Promise.reject(new Error("the test made no api available")),
) {
  const control: TestControlDb = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const asConsole = await asServiceRole(control.url, "kerby_console", 2);
  cleanups.push(() => asConsole.close());

  const signups: SignupClient = async ({ name, email, passwordHash }) => {
    const taken = await control.db.query("select 1 from tenants where name = $1", [name]);
    if (taken.rowCount) return { ok: false, code: "name_taken" };
    const tenant = await insertTenant(control.db, { name, dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, tenant.id, "active");
    const integration = await ensureDefaultIntegration(control.db, tenant.id);
    const { secret } = await createApiKey(control.db, tenant.id, integration.id, "initial");
    try {
      const user = await insertConsoleUser(control.db, {
        tenantId: tenant.id,
        email,
        passwordHash,
      });
      return { ok: true, tenantId: tenant.id, userId: user.id, secret };
    } catch {
      return { ok: false, code: "email_taken" };
    }
  };
  const pair = generateSecretsKeyPair();
  const service: ConsoleService = createConsoleService({
    control: asConsole,
    sealer: createSealer(pair.publicKey),
    signups,
    api,
    settings: {
      modelProviders: ["anthropic", "openai", "opencode"],
      judgmentProviders: ["typesafe", "opencode"],
      apiPublicUrl: "https://api.example.com",
      sessionTtlMs: 60_000,
      passwordCost: COST,
      signupsPerHour: 100,
      failedLoginsPerMinute: 100,
      failedLoginsPerAccountPerHour: 100,
      ...settings,
    },
  });
  const signUp = async (name: string, email = `${name}@example.com`, client = "203.0.113.1") => {
    const result = await service.signUp({ name, email, password: PASSWORD }, client);
    if (!result.ok) throw new Error(`sign-up refused: ${JSON.stringify(result)}`);
    const session = (await service.session(result.token)) ?? expect.fail("no session");
    return { ...result, session };
  };
  return { control, service, signUp, opener: createOpener([pair.privateKey]) };
}

describe("passwords", () => {
  it("verifies the password it hashed and nothing else", async () => {
    const stored = await hashPassword(PASSWORD, COST);
    expect(stored).toMatch(/^scrypt\$10\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("correct horse battery!", stored)).toBe(false);
    expect(await hashPassword(PASSWORD, COST)).not.toBe(stored); // a salt per hash
    // a hash this code would not make, or one demanding too much memory, is a mismatch rather than a crash
    for (const bad of [
      "",
      "plain",
      stored.replace("$10$", "$0$"),
      stored.replace("$10$", "$30$"),
    ]) {
      expect(await verifyPassword(PASSWORD, bad), bad).toBe(false);
    }
  });
});

describe("accounts", () => {
  it("signs up into a session, signs out, and signs in again with the password", async () => {
    const h = await harness();
    const created = await h.service.signUp(
      { name: "acme", email: " Ada@Example.com ", password: PASSWORD },
      "203.0.113.1",
    );
    expect(created).toMatchObject({ ok: true, apiKey: expect.stringMatching(/^kb_/) });
    if (!created.ok) return;
    expect(await h.service.session(created.token)).toMatchObject({
      email: "ada@example.com",
      tenantName: "acme",
    });
    // the first API key works at the api
    const tenant = await authenticateApiKey(h.control.db, created.apiKey);
    expect(tenant?.tenant.name).toBe("acme");

    await h.service.logOut(created.token);
    expect(await h.service.session(created.token)).toBeUndefined();

    const wrong = await h.service.logIn({ email: "ada@example.com", password: "nope" }, "a");
    expect(wrong).toEqual({ ok: false, error: "Wrong email or password." });
    const unknown = await h.service.logIn({ email: "bob@example.com", password: PASSWORD }, "a");
    expect(unknown).toEqual(wrong);
    const signedIn = await h.service.logIn({ email: "ADA@example.com", password: PASSWORD }, "a");
    expect(signedIn.ok).toBe(true);
    if (signedIn.ok) expect((await h.service.session(signedIn.token))?.tenantName).toBe("acme");
    expect(await h.service.session("not-a-token")).toBeUndefined();
  });

  it("names the bad field, and a taken workspace name or email", async () => {
    const h = await harness();
    await h.signUp("acme", "ada@example.com");
    const attempt = (form: Record<string, string>) => h.service.signUp(form, "203.0.113.1");
    expect(await attempt({ name: "Acme Inc", email: "x@example.com", password: PASSWORD })).toEqual(
      { ok: false, fields: { name: "Lowercase letters, digits and dashes" } },
    );
    expect(await attempt({ name: "x", email: "nope", password: PASSWORD })).toEqual({
      ok: false,
      fields: { email: "An email address like you@example.com" },
    });
    expect(await attempt({ name: "x", email: "x@example.com", password: "short" })).toEqual({
      ok: false,
      fields: { password: "At least 10 characters" },
    });
    expect(await attempt({ name: "acme", email: "x@example.com", password: PASSWORD })).toEqual({
      ok: false,
      fields: { name: "This workspace name is taken" },
    });
    expect(
      await attempt({ name: "x", email: "ada@example.com", password: PASSWORD }),
    ).toMatchObject({ ok: false, fields: { email: expect.stringContaining("exists") } });
  });

  it("limits sign-ups per address, and failed sign-ins per address and per account", async () => {
    const h = await harness({
      signupsPerHour: 2,
      failedLoginsPerMinute: 3,
      failedLoginsPerAccountPerHour: 5,
    });
    await h.signUp("a", "a@example.com", "198.51.100.1");
    await h.signUp("b", "b@example.com", "198.51.100.1");
    const third = await h.service.signUp(
      { name: "c", email: "c@example.com", password: PASSWORD },
      "198.51.100.1",
    );
    expect(third).toMatchObject({ ok: false, error: expect.stringMatching(/^Too many sign-ups/) });
    await h.signUp("c", "c@example.com", "198.51.100.2"); // another address is not affected

    const logIn = (password: string, client: string) =>
      h.service.logIn({ email: "a@example.com", password }, client);
    for (let i = 0; i < 3; i++) expect((await logIn("wrong", "192.0.2.1")).ok).toBe(false);
    // the address is refused even with the right password, before any password is checked
    expect(await logIn(PASSWORD, "192.0.2.1")).toMatchObject({
      error: expect.stringMatching(/^Too many failed sign-ins/),
    });
    expect((await logIn(PASSWORD, "192.0.2.2")).ok).toBe(true);
    // five failures against one account from anywhere lock that account for everyone
    for (const client of ["192.0.2.3", "192.0.2.4"]) await logIn("wrong", client);
    expect(await logIn(PASSWORD, "192.0.2.5")).toMatchObject({
      error: expect.stringMatching(/^Too many failed sign-ins/),
    });
    expect(
      (await h.service.logIn({ email: "b@example.com", password: PASSWORD }, "192.0.2.5")).ok,
    ).toBe(true);
  });

  it("ends a suspended tenant's sessions at once and refuses its sign-ins", async () => {
    const h = await harness();
    const { token, session } = await h.signUp("acme");
    await setTenantStatus(h.control.db, session.tenantId, "suspended");
    expect(await h.service.session(token)).toBeUndefined();
    expect(
      await h.service.logIn({ email: "acme@example.com", password: PASSWORD }, "a"),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not active") });
  });
});

describe("workspace", () => {
  it("seals a model key for a supported provider and removes it", async () => {
    const h = await harness();
    const { session } = await h.signUp("acme");
    expect(await h.service.setModelKey(session, "nope", { apiKey: "sk-test-123456" })).toEqual({
      ok: false,
      error: "Unknown model provider.",
    });
    expect(await h.service.setModelKey(session, "anthropic", { apiKey: "has space" })).toEqual({
      ok: false,
      fields: { apiKey: "An API key is printable ASCII without spaces" },
    });
    expect(
      await h.service.setModelKey(session, "anthropic", { apiKey: " sk-ant-test-123456\n" }),
    ).toEqual({ ok: true });
    expect(await readModelKey(h.control.db, h.opener, session.tenantId, "anthropic")).toBe(
      "sk-ant-test-123456",
    );
    const providers = await h.service.providers(session);
    // OpenCode is both a chat and a decision provider, and is listed once.
    expect(providers.map((p) => [p.id, p.configured, p.chat, p.decisions])).toEqual([
      ["anthropic", true, true, false],
      ["openai", false, true, false],
      ["opencode", false, true, true],
      ["typesafe", false, false, true],
    ]);
    // A judgment provider takes a key the same way.
    expect(await h.service.setModelKey(session, "typesafe", { apiKey: "ts-key-123456" })).toEqual({
      ok: true,
    });
    expect(await readModelKey(h.control.db, h.opener, session.tenantId, "typesafe")).toBe(
      "ts-key-123456",
    );
    expect((await h.service.overview(session)).modelKeys).toBe(2);
    expect(await h.service.removeModelKey(session, "typesafe")).toBe(true);
    expect(await h.service.removeModelKey(session, "anthropic")).toBe(true);
    expect(await h.service.removeModelKey(session, "anthropic")).toBe(false);

    const { rows } = await h.control.db.query<{ action: string; actor: string }>(
      "select action, actor from audit_log where tenant_id = $1 order by id",
      [session.tenantId],
    );
    expect(rows).toEqual([
      { action: "model_key.set", actor: `user:${session.userId}` },
      { action: "model_key.set", actor: `user:${session.userId}` },
      { action: "model_key.delete", actor: `user:${session.userId}` },
      { action: "model_key.delete", actor: `user:${session.userId}` },
    ]);
  });
});

/** A subscription as the api answers it. */
const subscriptionBody = (integrationId: string, overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  integrationId,
  destination: { kind: "webhook", url: "https://example.com/hook" },
  types: ["turn.*"],
  scope: "own",
  description: "",
  state: "active",
  disabledReason: null,
  failingSince: null,
  createdAt: "2026-11-23T10:00:00.000Z",
  updatedAt: "2026-11-23T10:00:00.000Z",
  ...overrides,
});

describe("integrations", () => {
  it("makes integrations with their scopes, refuses a name a live one has, and keeps each key in the integration it was made in", async () => {
    const h = await harness();
    const a = await h.signUp("acme");
    const b = await h.signUp("globex");
    const created = await h.service.createIntegration(a.session, {
      name: "  Support bot ",
      "scope.events": "on",
      "scope.conversations": "on",
    });
    if (!created.ok) return expect.fail(JSON.stringify(created));
    expect(await h.service.integration(a.session, created.id)).toMatchObject({
      name: "Support bot",
      scopes: ["conversations", "events"], // catalog order, whatever the form's
      keys: [],
    });

    // a name a live integration of the tenant has (the provisioned `default` too); another tenant's does not count
    for (const name of ["Support bot", "default"]) {
      expect(await h.service.createIntegration(a.session, { name, "scope.events": "on" })).toEqual({
        ok: false,
        fields: { name: "An integration already has this name. Choose another." },
      });
    }
    expect(
      (await h.service.createIntegration(b.session, { name: "Support bot", "scope.events": "on" }))
        .ok,
    ).toBe(true);
    expect(await h.service.createIntegration(a.session, { name: "-x" })).toEqual({
      ok: false,
      fields: {
        name: "Letters, digits, spaces, dots, dashes, underscores",
        scopes: "Choose at least one scope.",
      },
    });

    const key = await h.service.createApiKey(a.session, created.id, { label: " ci " });
    if (!key.ok) return expect.fail(JSON.stringify(key));
    expect(key.key.label).toBe("ci");
    const authenticated = await authenticateApiKey(h.control.db, key.secret);
    expect(authenticated?.tenant.name).toBe("acme");
    expect(authenticated?.integration).toMatchObject({
      id: created.id,
      scopes: ["conversations", "events"],
    });
    expect((await h.service.integration(a.session, created.id))?.keys.map((k) => k.label)).toEqual([
      "ci",
    ]);
    expect(await h.service.createApiKey(a.session, created.id, { label: "x".repeat(101) })).toEqual(
      { ok: false, fields: { label: "At most 100 characters" } },
    );

    // another tenant's session cannot see the integration, add a key to it, re-scope it, revoke its key or delete it
    expect(await h.service.integration(b.session, created.id)).toBeUndefined();
    expect(await h.service.createApiKey(b.session, created.id, {})).toEqual({
      ok: false,
      error: "This integration no longer exists.",
    });
    expect(
      await h.service.setIntegrationScopes(b.session, created.id, { "scope.admin": "on" }),
    ).toEqual({ ok: false, error: "This integration no longer exists." });
    expect(await h.service.revokeApiKey(b.session, key.key.id)).toBe(false);
    expect(await h.service.deleteIntegration(b.session, created.id)).toBe(false);
    expect(await authenticateApiKey(h.control.db, key.secret)).toBeDefined();

    // a re-scope reaches the key; no scope at all is refused
    expect(
      await h.service.setIntegrationScopes(a.session, created.id, { "scope.admin": "on" }),
    ).toEqual({ ok: true });
    expect((await authenticateApiKey(h.control.db, key.secret))?.integration.scopes).toEqual([
      "admin",
    ]);
    expect(await h.service.setIntegrationScopes(a.session, created.id, {})).toEqual({
      ok: false,
      fields: { scopes: "Choose at least one scope." },
    });

    expect(await h.service.revokeApiKey(a.session, key.key.id)).toBe(true);
    expect(await authenticateApiKey(h.control.db, key.secret)).toBeUndefined();
    expect((await h.service.overview(a.session)).activeApiKeys).toBe(1);
  });

  it("counts live keys and subscriptions per integration, and a delete revokes the keys and deletes the subscriptions", async () => {
    let listed: unknown[] = [];
    const calls: Parameters<ApiClient>[0][] = [];
    const h = await harness({}, async (request) => {
      calls.push(request);
      return new Response(JSON.stringify({ subscriptions: listed }), { status: 200 });
    });
    const { session, token } = await h.signUp("acme");
    const created = await h.service.createIntegration(session, {
      name: "back office",
      "scope.conversations": "on",
    });
    if (!created.ok) return expect.fail(JSON.stringify(created));
    const keys = [];
    for (const label of ["one", "two"]) {
      const key = await h.service.createApiKey(session, created.id, { label });
      if (!key.ok) return expect.fail(JSON.stringify(key));
      keys.push(key);
    }
    await h.service.revokeApiKey(session, keys[0]?.key.id ?? "");
    // the row the api would have written, so the delete has one to remove
    const subscription = await insertSubscription(
      h.control.db,
      createSealer(generateSecretsKeyPair().publicKey),
      {
        id: randomUUID(),
        tenantId: session.tenantId,
        integrationId: created.id,
        destination: { kind: "webhook", url: "https://example.com/hook" },
        types: ["*"],
        scope: "own",
        description: "",
        secret: "whsec_test",
      },
      10,
    );
    listed = [subscriptionBody(created.id, { id: subscription.id })];

    const access = { session, token };
    expect(
      (await h.service.integrations(access)).map((i) => [
        i.name,
        i.scopes,
        i.activeKeys,
        i.subscriptions,
      ]),
    ).toEqual([
      ["default", ["conversations", "judgments", "events", "tenant", "admin"], 1, 0],
      ["back office", ["conversations"], 1, 1],
    ]);
    expect(calls).toEqual([{ method: "GET", path: "/v1/subscriptions", token }]);

    expect(await h.service.deleteIntegration(session, created.id)).toBe(true);
    expect(await h.service.deleteIntegration(session, created.id)).toBe(false);
    expect(await authenticateApiKey(h.control.db, keys[1]?.secret ?? "")).toBeUndefined();
    expect(await h.service.integration(session, created.id)).toBeUndefined();
    // deleted subscriptions are tombstones until a dispatcher cancels their deliveries (ADR 0019): none is live
    const left = await h.control.db.query<{ state: string }>(
      "select state from subscriptions where integration_id = $1",
      [created.id],
    );
    expect(left.rows.map((row) => row.state)).toEqual(["deleted"]);
    expect(await listSubscriptions(h.control.db, session.tenantId)).toEqual([]);
    // a key cannot be made in a deleted integration, and its name is free again
    expect(await h.service.createApiKey(session, created.id, {})).toEqual({
      ok: false,
      error: "This integration no longer exists.",
    });
    expect(
      (await h.service.createIntegration(session, { name: "back office", "scope.events": "on" }))
        .ok,
    ).toBe(true);

    const { rows } = await h.control.db.query<{ action: string; actor: string; detail: unknown }>(
      "select action, actor, detail from audit_log where tenant_id = $1 order by id",
      [session.tenantId],
    );
    const actor = `user:${session.userId}`;
    expect(rows).toEqual([
      {
        action: "integration.create",
        actor,
        detail: { integrationId: created.id, name: "back office", scopes: "conversations" },
      },
      {
        action: "key.create",
        actor,
        detail: { keyId: keys[0]?.key.id, integrationId: created.id },
      },
      {
        action: "key.create",
        actor,
        detail: { keyId: keys[1]?.key.id, integrationId: created.id },
      },
      { action: "key.revoke", actor, detail: { keyId: keys[0]?.key.id } },
      { action: "integration.delete", actor, detail: { integrationId: created.id } },
      {
        action: "integration.create",
        actor,
        detail: { integrationId: expect.any(String), name: "back office", scopes: "events" },
      },
    ]);
  });

  it("audits a re-scope", async () => {
    const h = await harness();
    const { session } = await h.signUp("acme");
    const created = await h.service.createIntegration(session, {
      name: "bot",
      "scope.conversations": "on",
    });
    if (!created.ok) return expect.fail(JSON.stringify(created));
    await h.service.setIntegrationScopes(session, created.id, {
      "scope.tenant": "on",
      "scope.events": "on",
    });
    const { rows } = await h.control.db.query<{ action: string; detail: unknown }>(
      "select action, detail from audit_log where tenant_id = $1 and action = 'integration.scopes'",
      [session.tenantId],
    );
    expect(rows).toEqual([
      {
        action: "integration.scopes",
        detail: { integrationId: created.id, scopes: "events,tenant" },
      },
    ]);
  });
});

describe("subscriptions", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, code: string, message = code) =>
    json(status, { error: { code, message } });
  const INTEGRATION_ID = "0b6c1f7e-2a4d-4e8b-9c3a-5d7e9f1a2b3c";
  const SUBSCRIPTION_ID = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  /** The console over a scripted api: every request it makes is recorded, `answer` says what the api replies. */
  async function subscriptionHarness(answer: (request: Parameters<ApiClient>[0]) => Response) {
    const calls: Parameters<ApiClient>[0][] = [];
    const h = await harness({}, async (request) => {
      calls.push(request);
      return answer(request);
    });
    const user = await h.signUp("acme");
    return { ...h, calls, access: { session: user.session, token: user.token } };
  }

  it("creates a webhook subscription from the ticked boxes, as few patterns as say the same, and returns its secret", async () => {
    const h = await subscriptionHarness(() =>
      json(201, {
        subscription: subscriptionBody(INTEGRATION_ID, { id: SUBSCRIPTION_ID }),
        secret: "whsec_c2VjcmV0",
      }),
    );
    const created = await h.service.createSubscription(h.access, INTEGRATION_ID, {
      url: " https://example.com/hook ",
      description: " tickets ",
      scope: "tenant",
      // a family's wildcard covers its types; a lone type stays itself
      "type.turn.*": "on",
      "type.turn.started": "on",
      "type.message.created": "on",
    });
    expect(created).toMatchObject({
      ok: true,
      secret: "whsec_c2VjcmV0",
      subscription: { id: SUBSCRIPTION_ID },
    });
    expect(h.calls).toEqual([
      {
        method: "POST",
        path: "/v1/subscriptions",
        token: h.access.token,
        body: {
          integrationId: INTEGRATION_ID,
          destination: { kind: "webhook", url: "https://example.com/hook" },
          types: ["message.created", "turn.*"],
          scope: "tenant",
          description: "tickets",
        },
      },
    ]);

    // `*` says it all; a scope that is neither falls back to the integration's own events
    await h.service.createSubscription(h.access, INTEGRATION_ID, {
      url: "https://example.com/hook",
      scope: "everything",
      "type.*": "on",
      "type.judgment.failed": "on",
    });
    expect(h.calls[1]?.body).toMatchObject({ types: ["*"], scope: "own", description: "" });

    // nothing ticked, or a URL that is not one, never reaches the api
    expect(await h.service.createSubscription(h.access, INTEGRATION_ID, { url: "" })).toEqual({
      ok: false,
      fields: {
        url: "Enter the URL that receives the events",
        types: "Choose at least one event type.",
      },
    });
    expect(
      await h.service.createSubscription(h.access, INTEGRATION_ID, {
        url: "ftp://example.com",
        "type.*": "on",
      }),
    ).toEqual({ ok: false, fields: { url: "An http(s) URL" } });
    expect(
      await h.service.createSubscription(h.access, "not-an-id", {
        url: "https://example.com",
        "type.*": "on",
      }),
    ).toEqual({ ok: false, error: "This integration no longer exists." });
    expect(h.calls).toHaveLength(2);
  });

  it("tells the person why the api refused a subscription, and treats anything else as a fault", async () => {
    let reply = error(400, "invalid_destination", "private addresses cannot receive events");
    const h = await subscriptionHarness(() => reply);
    const create = () =>
      h.service.createSubscription(h.access, INTEGRATION_ID, {
        url: "https://10.0.0.1/hook",
        scope: "tenant",
        "type.*": "on",
      });
    expect(await create()).toEqual({
      ok: false,
      fields: { url: "private addresses cannot receive events" },
    });
    reply = error(403, "forbidden", "the integration lacks the tenant scope");
    expect(await create()).toEqual({
      ok: false,
      fields: { scope: "the integration lacks the tenant scope" },
    });
    reply = error(409, "subscription_limit", "a tenant may hold at most 10 subscriptions");
    expect(await create()).toEqual({
      ok: false,
      error: "a tenant may hold at most 10 subscriptions",
    });
    reply = error(404, "not_found");
    expect(await create()).toEqual({ ok: false, error: "This integration no longer exists." });
    reply = error(429, "rate_limited");
    expect(await h.service.rotateSubscriptionSecret(h.access, SUBSCRIPTION_ID)).toEqual({
      ok: false,
      error: "Too many requests. Try again in a moment.",
    });
    reply = error(404, "not_found");
    expect(await h.service.testSubscription(h.access, SUBSCRIPTION_ID)).toEqual({
      ok: false,
      error: "This subscription no longer exists. Reload the page.",
    });
    reply = error(401, "unauthorized");
    await expect(create()).rejects.toThrow(/401 unauthorized/);
    reply = new Response("bad gateway", { status: 502 });
    await expect(h.service.deleteSubscription(h.access, SUBSCRIPTION_ID)).rejects.toThrow(/502/);
  });

  it("lists an integration's subscriptions, reads one and its delivery log, and manages it through the api", async () => {
    const mine = subscriptionBody(INTEGRATION_ID, { id: SUBSCRIPTION_ID });
    const other = subscriptionBody(randomUUID());
    const delivery = {
      id: "41",
      eventIds: [randomUUID()],
      attempt: 2,
      outcome: "failed",
      willRetry: true,
      status: 500,
      error: "HTTP 500",
      response: "oops",
      durationMs: 120,
      at: "2026-11-23T10:00:00.000Z",
    };
    const h = await subscriptionHarness((request) => {
      const path = new URL(request.path, "http://api").pathname;
      if (request.method === "GET" && path === "/v1/subscriptions") {
        return json(200, { subscriptions: [mine, other] });
      }
      if (path.endsWith("/deliveries"))
        return json(200, { deliveries: [delivery], nextBefore: "41" });
      if (path.endsWith("/secret")) {
        return json(200, { secret: "whsec_bmV3", previousExpiresAt: "2026-11-24T10:00:00.000Z" });
      }
      if (path.endsWith("/test")) return json(202, { eventId: SUBSCRIPTION_ID });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (path === `/v1/subscriptions/${SUBSCRIPTION_ID}`) return json(200, mine);
      return error(404, "not_found");
    });
    const { access, calls } = h;

    expect((await h.service.subscriptions(access, INTEGRATION_ID)).map((s) => s.id)).toEqual([
      SUBSCRIPTION_ID,
    ]);
    expect(await h.service.subscription(access, SUBSCRIPTION_ID)).toEqual(mine);
    expect(await h.service.subscription(access, randomUUID())).toBeUndefined();
    expect(await h.service.deliveries(access, SUBSCRIPTION_ID, "41")).toEqual({
      deliveries: [delivery],
      nextBefore: "41",
    });
    // a position the api would refuse reads the newest page
    await h.service.deliveries(access, SUBSCRIPTION_ID, "41; drop");
    expect(await h.service.setSubscriptionEnabled(access, SUBSCRIPTION_ID, false)).toEqual({
      ok: true,
    });
    expect(await h.service.rotateSubscriptionSecret(access, SUBSCRIPTION_ID)).toEqual({
      ok: true,
      secret: "whsec_bmV3",
      previousExpiresAt: "2026-11-24T10:00:00.000Z",
    });
    expect(await h.service.testSubscription(access, SUBSCRIPTION_ID)).toEqual({
      ok: true,
      eventId: SUBSCRIPTION_ID,
    });
    expect(await h.service.deleteSubscription(access, SUBSCRIPTION_ID)).toEqual({ ok: true });

    const path = `/v1/subscriptions/${SUBSCRIPTION_ID}`;
    expect(calls.map(({ method, path, body }) => [method, path, body])).toEqual([
      ["GET", "/v1/subscriptions", undefined],
      ["GET", path, undefined],
      ["GET", expect.stringMatching(/^\/v1\/subscriptions\/[0-9a-f-]{36}$/), undefined],
      ["GET", `${path}/deliveries?limit=25&before=41`, undefined],
      ["GET", `${path}/deliveries?limit=25`, undefined],
      ["PATCH", path, { enabled: false }],
      ["POST", `${path}/secret`, undefined],
      ["POST", `${path}/test`, undefined],
      ["DELETE", path, undefined],
    ]);
    // the person's session token on every call
    expect(new Set(calls.map((call) => call.token))).toEqual(new Set([access.token]));

    // an id that is not one never reaches a path
    const before = calls.length;
    expect(await h.service.subscription(access, "../prompts")).toBeUndefined();
    expect(await h.service.deliveries(access, "../prompts")).toBeUndefined();
    expect(await h.service.deleteSubscription(access, "x/y")).toEqual({
      ok: false,
      error: "This subscription no longer exists. Reload the page.",
    });
    expect(calls).toHaveLength(before);
  });
});

describe("chats", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, code: string, message = code) =>
    json(status, { error: { code, message } });
  const CONVERSATION_ID = "5f0f3b8e-6d1f-4a39-9d3e-0c5a6f0b7a11";

  /** The console over a scripted api: every request it makes is recorded, `answer` says what the api replies. */
  async function chatHarness(answer: (request: Parameters<ApiClient>[0]) => Response) {
    const calls: Parameters<ApiClient>[0][] = [];
    const h = await harness({}, async (request) => {
      calls.push(request);
      return answer(request);
    });
    const user = await h.signUp("acme");
    return { ...h, calls, access: { session: user.session, token: user.token } };
  }

  it("starts a conversation as the signed-in person, posts the first message, and refuses a provider without a key before asking the api", async () => {
    const h = await chatHarness((request) =>
      request.method === "POST" && request.path === "/v1/conversations"
        ? json(201, { id: CONVERSATION_ID })
        : json(202, { seq: 1 }),
    );
    expect(await h.service.createChat(h.access, { message: "   " })).toEqual({
      ok: false,
      fields: { message: "Write a message first" },
    });
    expect(
      await h.service.createChat(h.access, { message: "hi", model: "anthropic/claude-x" }),
    ).toEqual({
      ok: false,
      fields: { model: "No anthropic key yet: add one under Model providers." },
    });
    expect(h.calls).toEqual([]);

    await h.service.setModelKey(h.access.session, "anthropic", { apiKey: "sk-ant-test-123456" });
    expect(
      await h.service.createChat(h.access, {
        message: " hello there ",
        model: " anthropic/claude-x ",
        system: "",
      }),
    ).toEqual({ ok: true, id: CONVERSATION_ID });
    expect(h.calls).toEqual([
      {
        method: "POST",
        path: "/v1/conversations",
        token: h.access.token,
        body: { externalUserId: `console:${h.access.session.userId}`, model: "anthropic/claude-x" },
      },
      {
        method: "POST",
        path: `/v1/conversations/${CONVERSATION_ID}/messages`,
        token: h.access.token,
        body: { content: "hello there" },
      },
    ]);
  });

  it("tells the person why the api refused, and treats anything else as a fault", async () => {
    let reply = error(409, "conversation_busy");
    const h = await chatHarness(() => reply);
    const send = () => h.service.sendMessage(h.access, CONVERSATION_ID, { message: "hi" });
    expect(await send()).toEqual({
      ok: false,
      error: "A reply is still being written. Wait for it to finish.",
    });
    reply = error(413, "conversation_full");
    expect(await send()).toMatchObject({ ok: false, error: expect.stringContaining("full") });
    reply = error(404, "not_found");
    expect(await send()).toMatchObject({
      ok: false,
      error: expect.stringContaining("no longer exists"),
    });
    reply = error(401, "unauthorized");
    await expect(send()).rejects.toThrow(/401 unauthorized/);
    reply = error(400, "invalid_model", "model is required: <provider>/<modelId>");
    expect(await h.service.createChat(h.access, { message: "hi" })).toEqual({
      ok: false,
      fields: { model: "model is required: <provider>/<modelId>" },
    });
  });

  it("reads a whole conversation across the api's pages, and lists with the origin of each", async () => {
    const message = (seq: number) => ({
      seq,
      createdAt: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: `m${seq}` }] },
    });
    const conversation = {
      id: CONVERSATION_ID,
      externalUserId: "customer-7",
      integrationId: null,
      model: "faux/faux-1",
      system: "",
      title: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const h = await chatHarness((request) => {
      if (request.path.startsWith("/v1/conversations?")) {
        return json(200, {
          conversations: [
            { ...conversation, messageCount: 3, system: undefined },
            {
              ...conversation,
              id: crypto.randomUUID(),
              externalUserId: "console:someone",
              messageCount: 0,
              system: undefined,
            },
          ],
          nextCursor: null,
        });
      }
      const after = Number(new URL(request.path, "http://api").searchParams.get("after"));
      return json(200, {
        conversation,
        messages: after === 0 ? [message(1), message(2)] : [message(3)],
        nextAfter: after === 0 ? 2 : null,
        busy: true,
        lastError: null,
      });
    });
    const chat = await h.service.chat(h.access, CONVERSATION_ID);
    expect(chat?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(chat).toMatchObject({ busy: true, origin: "api", externalUserId: "customer-7" });
    expect((await h.service.chats(h.access)).chats.map((c) => c.origin)).toEqual([
      "api",
      "console",
    ]);
  });

  it("never puts an id or a position it did not check into a path", async () => {
    const h = await chatHarness(() => json(200, {}));
    const signal = new AbortController().signal;
    expect(await h.service.chat(h.access, "../v1/model-keys")).toBeUndefined();
    expect(await h.service.chatStatus(h.access, "x")).toBeUndefined();
    expect(await h.service.sendMessage(h.access, "x/../y", { message: "hi" })).toMatchObject({
      ok: false,
    });
    expect((await h.service.chatEvents(h.access, "x", null, signal)).status).toBe(404);
    expect((await h.service.chatEvents(h.access, CONVERSATION_ID, "1; drop", signal)).status).toBe(
      404,
    );
    expect(h.calls).toEqual([]);
    await h.service.chatEvents(h.access, CONVERSATION_ID, "7", signal);
    expect(h.calls).toEqual([
      expect.objectContaining({
        path: `/v1/conversations/${CONVERSATION_ID}/events?after=7`,
        token: h.access.token,
        stream: true,
      }),
    ]);
  });

  it("starts a chat from a published prompt by reference, with only the variables typed, and says why it was refused", async () => {
    let reply = () => json(201, { id: CONVERSATION_ID });
    const h = await chatHarness((request) =>
      request.path === "/v1/conversations" ? reply() : json(202, { seq: 1 }),
    );
    // The prompt sets the model: a provider without a key in the hidden model field is not this form's concern.
    expect(
      await h.service.createChat(h.access, {
        message: "hi",
        model: "anthropic/claude-x",
        system: "ignored",
        promptName: "support/triage",
        promptVersion: "production",
        "var.customer": "Ada",
        "var.tone": "",
      }),
    ).toEqual({ ok: true, id: CONVERSATION_ID });
    expect(h.calls[0]?.body).toEqual({
      externalUserId: `console:${h.access.session.userId}`,
      prompt: { name: "support/triage", version: "production", variables: { customer: "Ada" } },
    });
    h.calls.length = 0;
    await h.service.createChat(h.access, {
      message: "hi",
      promptName: "support/triage",
      promptVersion: "3",
    });
    expect(h.calls[0]?.body).toEqual({
      externalUserId: `console:${h.access.session.userId}`,
      prompt: { name: "support/triage", version: 3 },
    });

    reply = () => error(400, "invalid_variables", "variable customer is required: give it a value");
    expect(
      await h.service.createChat(h.access, { message: "hi", promptName: "a", promptVersion: "1" }),
    ).toEqual({ ok: false, error: "variable customer is required: give it a value" });
    reply = () => error(404, "not_found");
    expect(
      await h.service.createChat(h.access, { message: "hi", promptName: "a", promptVersion: "9" }),
    ).toMatchObject({ ok: false, fields: { promptVersion: expect.stringContaining("no longer") } });
  });
});

describe("studio", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, code: string, message = code) =>
    json(status, { error: { code, message } });
  const CONVERSATION_ID = "5f0f3b8e-6d1f-4a39-9d3e-0c5a6f0b7a11";
  const JUDGMENT_ID = "0b9f7c1e-2a4d-4e6b-8c1d-3f5a7b9c1d2e";
  const AT = "2026-11-22T00:00:00.000Z";

  const prompt = (draft: Record<string, unknown>) => ({
    name: "support/triage",
    kind: draft.kind,
    latestVersion: 2,
    labels: { production: 1 },
    createdAt: AT,
    updatedAt: AT,
    draft,
    draftRevision: 4,
    draftUpdatedAt: AT,
    draftUpdatedBy: "user:x",
    versions: [],
  });
  const chatDraft = {
    kind: "chat",
    text: "Help {{customer}} in a {{ tone }} tone. {{undeclared}}",
    model: "opencode/big",
    guardrails: [
      { name: "jailbreak", appliesTo: "user_message", instructions: "Jailbreak?", blockAt: 0.7 },
    ],
    variables: [{ name: "customer" }, { name: "tone", default: "calm" }],
  };
  const decisionDraft = {
    kind: "decision",
    model: "typesafe/jev-latest",
    questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
  };

  async function studioHarness(answer: (request: Parameters<ApiClient>[0]) => Response) {
    const calls: Parameters<ApiClient>[0][] = [];
    const h = await harness({}, async (request) => {
      calls.push(request);
      return answer(request);
    });
    const user = await h.signUp("acme");
    return { ...h, calls, access: { session: user.session, token: user.token } };
  }

  it("runs the chat playground from the draft rendered here, or from a version by reference, as studio:<userId>", async () => {
    let draft: Record<string, unknown> = chatDraft;
    const h = await studioHarness((request) =>
      request.method === "GET" ? json(200, prompt(draft)) : json(201, { id: CONVERSATION_ID }),
    );
    await h.service.setModelKey(h.access.session, "opencode", { apiKey: "sk-opencode-123456" });
    const studioUser = `studio:${h.access.session.userId}`;

    expect(
      await h.service.startPlaygroundChat(h.access, "support/triage", { source: "draft" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("customer") });
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(h.calls[0]?.path).toBe("/v1/prompts/support%2Ftriage");

    h.calls.length = 0;
    expect(
      await h.service.startPlaygroundChat(h.access, "support/triage", {
        source: "draft",
        "var.customer": "Ada",
      }),
    ).toEqual({ ok: true, id: CONVERSATION_ID });
    expect(h.calls[1]).toEqual({
      method: "POST",
      path: "/v1/conversations",
      token: h.access.token,
      body: {
        externalUserId: studioUser,
        system: "Help Ada in a calm tone. {{undeclared}}",
        model: "opencode/big",
        guardrails: [{ ...chatDraft.guardrails[0] }],
      },
    });

    h.calls.length = 0;
    await h.service.startPlaygroundChat(h.access, "support/triage", {
      source: "production",
      "var.customer": "Ada",
    });
    expect(h.calls).toEqual([
      expect.objectContaining({
        method: "POST",
        body: {
          externalUserId: studioUser,
          prompt: { name: "support/triage", version: "production", variables: { customer: "Ada" } },
        },
      }),
    ]);

    // A draft's model whose provider has no key is caught before the api is asked to start anything.
    draft = { ...chatDraft, model: "anthropic/claude-x" };
    h.calls.length = 0;
    expect(
      await h.service.startPlaygroundChat(h.access, "support/triage", {
        source: "draft",
        "var.customer": "Ada",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("No anthropic key") });
    expect(h.calls.map((c) => c.method)).toEqual(["GET"]);

    const conversation = {
      id: CONVERSATION_ID,
      externalUserId: studioUser,
      integrationId: null,
      model: "opencode/big",
      title: null,
      createdAt: AT,
      updatedAt: AT,
      messageCount: 0,
      prompt: { name: "support/triage", version: 1 },
    };
    const list = await studioHarness(() =>
      json(200, { conversations: [conversation], nextCursor: null }),
    );
    expect((await list.service.chats(list.access)).chats.map((c) => c.origin)).toEqual(["studio"]);
  });

  it("runs the decision playground on a JSON state, from the draft's questions or a version", async () => {
    const h = await studioHarness((request) =>
      request.method === "GET" ? json(200, prompt(decisionDraft)) : json(202, { id: JUDGMENT_ID }),
    );
    expect(
      await h.service.runDecision(h.access, "support/triage", { source: "draft", state: "{nope" }),
    ).toMatchObject({ ok: false, fields: { state: expect.stringContaining("not valid JSON") } });
    expect(h.calls).toEqual([]);

    expect(
      await h.service.runDecision(h.access, "support/triage", {
        source: "draft",
        state: '{"message":"help"}',
      }),
    ).toEqual({ ok: true, id: JUDGMENT_ID });
    expect(h.calls[1]).toMatchObject({
      method: "POST",
      path: "/v1/judgments",
      body: {
        state: { message: "help" },
        questions: decisionDraft.questions,
        model: "typesafe/jev-latest",
      },
    });

    h.calls.length = 0;
    await h.service.runDecision(h.access, "support/triage", { source: "2", state: "[1]" });
    expect(h.calls).toEqual([
      expect.objectContaining({
        path: "/v1/judgments",
        body: { state: [1], prompt: { name: "support/triage", version: 2 } },
      }),
    ]);
  });

  it("says why a save, publish, create or delete was refused, and treats anything else as a fault", async () => {
    let reply = error(409, "draft_conflict");
    const h = await studioHarness(() => reply);
    const save = () => h.service.saveDraft(h.access, "support/triage", 4, decisionDraft);
    expect(await save()).toMatchObject({
      ok: false,
      conflict: true,
      error: expect.stringContaining("changed elsewhere"),
    });
    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/v1/prompts/support%2Ftriage/draft",
      body: { revision: 4, draft: decisionDraft },
    });

    const publish = () => h.service.publishPrompt(h.access, "support/triage", 4, { note: " v2 " });
    reply = error(400, "not_publishable", "the text is empty; variable x is not declared");
    expect(await publish()).toEqual({
      ok: false,
      error: "This draft cannot be published yet. the text is empty; variable x is not declared",
    });
    expect(h.calls.at(-1)?.body).toEqual({ revision: 4, note: "v2" });
    reply = error(409, "unchanged");
    expect(await publish()).toMatchObject({ error: expect.stringContaining("Nothing to publish") });

    reply = error(409, "name_taken");
    expect(
      await h.service.createPrompt(h.access, { name: "support/triage", kind: "chat" }),
    ).toMatchObject({
      ok: false,
      fields: { name: expect.stringContaining("already has this name") },
    });
    reply = error(409, "prompt_published");
    expect(await h.service.deletePrompt(h.access, "support/triage")).toMatchObject({
      error: expect.stringContaining("cannot be deleted"),
    });
    reply = error(500, "internal");
    await expect(save()).rejects.toThrow(/500 internal/);

    // A name or label that is not one never reaches a path.
    h.calls.length = 0;
    expect(await h.service.prompt(h.access, "../v1/model-keys")).toBeUndefined();
    expect(await h.service.deletePrompt(h.access, "a/../b")).toMatchObject({ ok: false });
    expect(await h.service.removePromptLabel(h.access, "a", "latest")).toMatchObject({ ok: false });
    expect(
      await h.service.setPromptLabel(h.access, "a", { label: "latest", version: "1" }),
    ).toMatchObject({ ok: false, fields: { label: expect.stringContaining("Latest") } });
    expect(h.calls).toEqual([]);
  });
});
