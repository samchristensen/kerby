// Who may sign up to the console (migration 0007), and who administers that list. Emails arrive normalized
// (contracts' `EmailSchema`).
import type { ControlQueryable } from "@kerby/db";

export type AllowedEmail = {
  email: string;
  addedAt: Date;
  /** Whether an account with this email exists now. */
  signedUp: boolean;
};

export async function isSignupAllowed(db: ControlQueryable, email: string): Promise<boolean> {
  const { rowCount } = await db.query("select 1 from signup_allowlist where email = $1", [email]);
  return rowCount === 1;
}

/** Oldest first. */
export async function listAllowedEmails(db: ControlQueryable): Promise<AllowedEmail[]> {
  const { rows } = await db.query<{ email: string; added_at: Date; signed_up: boolean }>(
    `select a.email, a.added_at, exists (select 1 from console_users u where u.email = a.email) as signed_up
       from signup_allowlist a
      order by a.added_at, a.email`,
  );
  return rows.map((row) => ({ email: row.email, addedAt: row.added_at, signedUp: row.signed_up }));
}

/** Allow `emails`, those already allowed staying as they are. Returns how many were new. */
export async function allowEmails(
  db: ControlQueryable,
  emails: readonly string[],
  addedBy: string | null,
): Promise<number> {
  const { rowCount } = await db.query(
    `insert into signup_allowlist (email, added_by)
     select email, $2::uuid from unnest($1::text[]) as email
     on conflict do nothing`,
    [emails, addedBy],
  );
  return rowCount ?? 0;
}

/** Stop allowing `email`. An account it already made stays. False when it was not on the list. */
export async function disallowEmail(db: ControlQueryable, email: string): Promise<boolean> {
  const { rowCount } = await db.query("delete from signup_allowlist where email = $1", [email]);
  return rowCount === 1;
}

/** Make the person with `email` an admin, or not. Undefined when there is no such account. */
export async function setConsoleAdmin(
  db: ControlQueryable,
  email: string,
  admin: boolean,
): Promise<{ id: string; tenantId: string } | undefined> {
  const { rows } = await db.query<{ id: string; tenant_id: string }>(
    "update console_users set is_admin = $2 where email = $1 returning id, tenant_id",
    [email, admin],
  );
  const row = rows[0];
  return row ? { id: row.id, tenantId: row.tenant_id } : undefined;
}
