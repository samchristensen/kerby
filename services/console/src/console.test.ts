import {
  authenticateApiKey,
  createApiKey,
  insertConsoleUser,
  insertTenant,
  readModelKey,
  setRolePassword,
  setTenantStatus,
} from "@kerby/control-plane";
import { createTestControlDb, type TestControlDb } from "@kerby/control-plane/testing";
import { createControlDb } from "@kerby/db";
import { createOpener, createSealer, generateSecretsKeyPair } from "@kerby/secrets";
import { afterEach, describe, expect, it } from "vitest";
import { createConsoleService } from "./service/index.ts";
import { hashPassword, verifyPassword } from "./service/passwords.ts";
import type { ConsoleDeps, ConsoleService, SignupClient } from "./types/index.ts";

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
async function harness(settings: Partial<ConsoleDeps["settings"]> = {}) {
  const control: TestControlDb = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  await setRolePassword(control.db, "kerby_console", "console-role-password-for-tests");
  const url = new URL(control.url);
  url.username = "kerby_console";
  url.password = "console-role-password-for-tests";
  const asConsole = createControlDb(url.toString(), { max: 2 });
  cleanups.push(() => asConsole.close());

  const signups: SignupClient = async ({ name, email, passwordHash }) => {
    const taken = await control.db.query("select 1 from tenants where name = $1", [name]);
    if (taken.rowCount) return { ok: false, code: "name_taken" };
    const tenant = await insertTenant(control.db, { name, dbHost: "h", dbPort: 1 });
    await setTenantStatus(control.db, tenant.id, "active");
    const { secret } = await createApiKey(control.db, tenant.id, "initial");
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
    settings: {
      modelProviders: ["anthropic", "openai"],
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
  it("creates, lists and revokes API keys of the session's tenant only", async () => {
    const h = await harness();
    const a = await h.signUp("acme");
    const b = await h.signUp("globex");
    const created = await h.service.createApiKey(a.session, { label: "  ci  " });
    if (!created.ok) return expect.fail(JSON.stringify(created));
    expect(created.key.label).toBe("ci");
    expect((await authenticateApiKey(h.control.db, created.secret))?.tenant.name).toBe("acme");
    expect((await h.service.apiKeys(a.session)).map((k) => k.label)).toEqual(["ci", "initial"]);
    expect(await h.service.createApiKey(a.session, { label: "x".repeat(101) })).toEqual({
      ok: false,
      fields: { label: "At most 100 characters" },
    });

    // another tenant's session cannot see or revoke it
    expect((await h.service.apiKeys(b.session)).map((k) => k.id)).not.toContain(created.key.id);
    expect(await h.service.revokeApiKey(b.session, created.key.id)).toBe(false);
    expect(await authenticateApiKey(h.control.db, created.secret)).toBeDefined();

    expect(await h.service.revokeApiKey(a.session, created.key.id)).toBe(true);
    expect(await authenticateApiKey(h.control.db, created.secret)).toBeUndefined();
    expect((await h.service.overview(a.session)).activeApiKeys).toBe(1);
  });

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
    expect((await h.service.providers(session)).map((p) => [p.id, p.configured])).toEqual([
      ["anthropic", true],
      ["openai", false],
    ]);
    expect((await h.service.overview(session)).modelKeys).toBe(1);
    expect(await h.service.removeModelKey(session, "anthropic")).toBe(true);
    expect(await h.service.removeModelKey(session, "anthropic")).toBe(false);

    const { rows } = await h.control.db.query<{ action: string; actor: string }>(
      "select action, actor from audit_log where tenant_id = $1 order by id",
      [session.tenantId],
    );
    expect(rows).toEqual([
      { action: "model_key.set", actor: `user:${session.userId}` },
      { action: "model_key.delete", actor: `user:${session.userId}` },
    ]);
  });
});
