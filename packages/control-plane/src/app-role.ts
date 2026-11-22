import type { ControlDb } from "@kerby/db";

/** The limited role api and worker use on the control database (migration 0002). */
export const APP_ROLE = "kerby_app";

/** Let the app role log in with `password`. Idempotent; run by the control service at startup. */
export async function setAppRolePassword(db: ControlDb, password: string): Promise<void> {
  const { rows } = await db.query<{ sql: string }>(
    "select format('alter role %I login password %L', $1::text, $2::text) as sql",
    [APP_ROLE, password],
  );
  await db.query(rows[0]?.sql ?? "");
}

/**
 * Only the app role and the admin may connect to the control database: no tenant role (nor anyone else `public`
 * would admit) can even open it. Idempotent.
 */
export async function restrictControlDatabase(db: ControlDb): Promise<void> {
  const { rows } = await db.query<{ revoke: string; grant: string }>(
    `select format('revoke connect on database %I from public', current_database()) as revoke,
            format('grant connect on database %I to %I, current_user', current_database(), $1::text) as grant`,
    [APP_ROLE],
  );
  await db.query(rows[0]?.revoke ?? "");
  await db.query(rows[0]?.grant ?? "");
}
