import type { ControlDb } from "@kerby/db";

/**
 * The limited roles services use on the control database: `kerby_app` for api and worker (migration 0002),
 * `kerby_console` for the console (migration 0005). Control holds the administrative URL and gives them passwords.
 */
const SERVICE_ROLES = ["kerby_app", "kerby_console"] as const;
type ServiceRole = (typeof SERVICE_ROLES)[number];

/** Let `role` log in with `password`. Idempotent; run by the control service at startup. */
export async function setRolePassword(
  db: ControlDb,
  role: ServiceRole,
  password: string,
): Promise<void> {
  const { rows } = await db.query<{ sql: string }>(
    "select format('alter role %I login password %L', $1::text, $2::text) as sql",
    [role, password],
  );
  await db.query(rows[0]?.sql ?? "");
}

/**
 * Only the service roles and the admin may connect to the control database: no tenant role (nor anyone else `public`
 * would admit) can even open it. Idempotent.
 */
export async function restrictControlDatabase(db: ControlDb): Promise<void> {
  const { rows } = await db.query<{ revoke: string; grant: string }>(
    `select format('revoke connect on database %I from public', current_database()) as revoke,
            format('grant connect on database %I to %s, current_user', current_database(),
                   (select string_agg(quote_ident(r), ', ') from unnest($1::text[]) as r)) as grant`,
    [SERVICE_ROLES],
  );
  await db.query(rows[0]?.revoke ?? "");
  await db.query(rows[0]?.grant ?? "");
}
