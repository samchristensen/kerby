// Provisioning primitives on a Postgres cluster (ADR 0004): a database per tenant, copied from a template and
// owned by a role that can reach only that database. Identifiers are validated and quoted here, once.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { childProcessEnv } from "@kerby/config";
import { createControlDb } from "./handles.ts";

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
/** Postgres: object_in_use. `create database ... template t` while a session is still closing on `t`. */
const OBJECT_IN_USE = "55006";

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`invalid ${what} "${name}": use [a-z][a-z0-9_], at most 63 characters`);
  }
  return `"${name}"`;
}

/**
 * Connections one tenant's role may hold across every api and worker process: the pools (2 each), live event streams
 * and the worker's listeners. The cluster's `max_connections` is shared by all tenants.
 */
export const TENANT_ROLE_CONNECTION_LIMIT = 50;

export interface ClusterAdmin {
  databaseExists(name: string): Promise<boolean>;
  roleExists(name: string): Promise<boolean>;
  /**
   * A login role with no rights beyond what is granted to it later, and a connection limit: one tenant must not
   * be able to use up the connections every other tenant and the control database share.
   */
  createRole(role: string, password: string): Promise<void>;
  /** Set (again) the connection limit of an existing tenant role; roles made before the limit existed get it. */
  limitRoleConnections(role: string): Promise<void>;
  /**
   * A new database, copied from `template` (which must have no open connections: a brief wait is retried) and
   * owned by `owner`. Objects in the copy keep the creating role as owner until `reassignOwned`.
   */
  createDatabase(name: string, options?: { template?: string; owner?: string }): Promise<void>;
  /** `public` may no longer connect to `database`; `role` and the admin role may, and no one else. */
  restrictDatabase(database: string, role: string): Promise<void>;
  /** Hand every object in `database` owned by the admin role to `role` (so the tenant owns its schema). */
  reassignOwned(database: string, role: string): Promise<void>;
  /** The admin URL pointed at another database of the cluster. */
  urlFor(database: string): string;
  /** Drops connections, then the database. No error when it is absent. */
  dropDatabase(name: string): Promise<void>;
  dropRole(role: string): Promise<void>;
  close(): Promise<void>;
}

/** An administrative connection to a cluster (a role with CREATEDB and CREATEROLE, on its maintenance database). */
export function createClusterAdmin(url: string): ClusterAdmin {
  const db = createControlDb(url, { max: 2 });
  const exec = async (sql: string) => {
    await db.query(sql);
  };
  const urlFor = (database: string) => {
    const target = new URL(url);
    target.pathname = `/${database}`;
    return target.toString();
  };
  return {
    urlFor,
    async databaseExists(name) {
      return (
        (await db.query("select 1 from pg_database where datname = $1", [name])).rowCount === 1
      );
    },
    async roleExists(name) {
      return (await db.query("select 1 from pg_roles where rolname = $1", [name])).rowCount === 1;
    },
    async createRole(role, password) {
      const quoted = identifier(role, "role name");
      // %L quotes the password as a literal; DDL cannot take bind parameters.
      const { rows } = await db.query<{ sql: string }>(
        "select format('create role %s login connection limit %s password %L', $1::text, $2::text, $3::text) as sql",
        [quoted, String(TENANT_ROLE_CONNECTION_LIMIT), password],
      );
      await exec(rows[0]?.sql ?? "");
      // A non-superuser admin (a managed Postgres without superuser access) may only create a database owned by, and
      // move objects to, a role it is a member of.
      await exec(`grant ${quoted} to current_user`);
    },
    async limitRoleConnections(role) {
      await exec(
        `alter role ${identifier(role, "role name")} connection limit ${TENANT_ROLE_CONNECTION_LIMIT}`,
      );
    },
    async createDatabase(name, options = {}) {
      const sql = [
        `create database ${identifier(name, "database name")}`,
        options.template ? `template ${identifier(options.template, "template name")}` : "",
        options.owner ? `owner ${identifier(options.owner, "role name")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      for (let attempt = 0; ; attempt++) {
        try {
          return await exec(sql);
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
          if (code !== OBJECT_IN_USE || attempt >= 50) throw error;
          await sleep(100);
        }
      }
    },
    async restrictDatabase(database, role) {
      const quotedDb = identifier(database, "database name");
      await exec(`revoke all on database ${quotedDb} from public`);
      await exec(
        `grant connect on database ${quotedDb} to ${identifier(role, "role name")}, current_user`,
      );
    },
    async reassignOwned(database, role) {
      // `quoted` is a validated, double-quoted identifier, so it is safe inside the statement text below.
      const quoted = identifier(role, "role name");
      const inDatabase = createControlDb(urlFor(database), { max: 1 });
      try {
        // REASSIGN OWNED cannot be used by a superuser (it owns the system objects), so move the user objects by
        // hand: schemas, relations and functions the admin role owns outside the system schemas.
        await inDatabase.query(`
          do $do$
          declare r record;
          begin
            for r in select nspname from pg_namespace
                      where pg_get_userbyid(nspowner) = current_user
                        and nspname not like 'pg\\_%' and nspname <> 'information_schema' loop
              execute format('alter schema %I owner to ${quoted}', r.nspname);
            end loop;
            for r in select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where pg_get_userbyid(c.relowner) = current_user
                        and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                        and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
                        -- sequences owned by a column and indexes follow their table
                        and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')) loop
              execute format('alter %s %I.%I owner to ${quoted}',
                case r.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view'
                               when 'f' then 'foreign table' else 'table' end,
                r.nspname, r.relname);
            end loop;
            for r in select n.nspname, p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) as args
                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where pg_get_userbyid(p.proowner) = current_user
                        and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema' loop
              execute format('alter %s %I.%I(%s) owner to ${quoted}',
                case r.prokind when 'p' then 'procedure' else 'function' end,
                r.nspname, r.proname, r.args);
            end loop;
          end
          $do$`);
      } finally {
        await inDatabase.close();
      }
    },
    async dropDatabase(name) {
      await exec(`drop database if exists ${identifier(name, "database name")} with (force)`);
    },
    async dropRole(role) {
      await exec(`drop role if exists ${identifier(role, "role name")}`);
    },
    close: () => db.close(),
  };
}

/** `pg_dump --format=custom` of the database at `url` into `file`. Rejects with pg_dump's stderr on failure. */
export function dumpDatabase(url: string, file: string, pgDump = "pg_dump"): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // The password travels in PGPASSWORD, not argv, where any local user could read it from the process list.
  const target = new URL(url);
  const password = decodeURIComponent(target.password);
  target.password = "";
  const child = spawn(
    pgDump,
    ["--format=custom", "--no-owner", "--file", file, "--dbname", target.toString()],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: childProcessEnv({ PGPASSWORD: password }),
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("error", reject);
  child.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`)),
  );
  return promise;
}
