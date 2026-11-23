// The tenant console's people and sessions (ADR 0014, migration 0005). Control inserts a person when it provisions
// their tenant at sign-up; the console reads people to check a password and keeps sessions. A session token is 256
// random bits that only the browser holds (a cookie); the table keeps its SHA-256, so reading it signs no one in.
import { createHash, randomBytes } from "node:crypto";
import type { ControlQueryable } from "@kerby/db";
import { errorCode } from "@kerby/observability";

export class EmailTakenError extends Error {
  override name = "EmailTakenError";
}

export type ConsoleUser = {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
};

type UserRow = { id: string; tenant_id: string; email: string; password_hash: string };

/** Insert a tenant's person. `email` arrives normalized (contracts' `EmailSchema`). Throws `EmailTakenError`. */
export async function insertConsoleUser(
  db: ControlQueryable,
  user: { tenantId: string; email: string; passwordHash: string },
): Promise<{ id: string }> {
  try {
    const { rows } = await db.query<{ id: string }>(
      "insert into console_users (tenant_id, email, password_hash) values ($1, $2, $3) returning id",
      [user.tenantId, user.email, user.passwordHash],
    );
    const row = rows[0];
    if (!row) throw new Error("console user insert returned no row");
    return row;
  } catch (error) {
    if (errorCode(error) === "23505")
      throw new EmailTakenError("an account with this email exists");
    throw error;
  }
}

export async function findConsoleUser(
  db: ControlQueryable,
  email: string,
): Promise<ConsoleUser | undefined> {
  const { rows } = await db.query<UserRow>(
    "select id, tenant_id, email, password_hash from console_users where email = $1",
    [email],
  );
  const row = rows[0];
  return row
    ? { id: row.id, tenantId: row.tenant_id, email: row.email, passwordHash: row.password_hash }
    : undefined;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest();
/** 32 random bytes, base64url: what `createConsoleSession` hands out. Anything else is not looked up. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Sign `user` in until `expiresAt`, and forget that person's expired sessions. The token goes to the browser only. */
export async function createConsoleSession(
  db: ControlQueryable,
  user: Pick<ConsoleUser, "id" | "tenantId">,
  expiresAt: Date,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query("delete from console_sessions where user_id = $1 and expires_at <= now()", [
    user.id,
  ]);
  await db.query(
    "insert into console_sessions (token_hash, tenant_id, user_id, expires_at) values ($1, $2, $3, $4)",
    [tokenHash(token), user.tenantId, user.id, expiresAt],
  );
  await db.query("update console_users set last_login_at = now() where id = $1", [user.id]);
  return token;
}

type ConsoleSession = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  expiresAt: Date;
};

/** The live session `token` names, with its person and tenant; undefined when unknown or expired. */
export async function readConsoleSession(
  db: ControlQueryable,
  token: string,
): Promise<ConsoleSession | undefined> {
  if (!TOKEN.test(token)) return undefined;
  const { rows } = await db.query<{
    user_id: string;
    email: string;
    tenant_id: string;
    tenant_name: string;
    tenant_status: string;
    expires_at: Date;
  }>(
    `select s.user_id, u.email, s.tenant_id, t.name as tenant_name, t.status as tenant_status, s.expires_at
       from console_sessions s
       join console_users u on u.id = s.user_id
       join tenants t on t.id = s.tenant_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash(token)],
  );
  const row = rows[0];
  return row
    ? {
        userId: row.user_id,
        email: row.email,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        tenantStatus: row.tenant_status,
        expiresAt: row.expires_at,
      }
    : undefined;
}

export async function deleteConsoleSession(db: ControlQueryable, token: string): Promise<void> {
  if (!TOKEN.test(token)) return;
  await db.query("delete from console_sessions where token_hash = $1", [tokenHash(token)]);
}
