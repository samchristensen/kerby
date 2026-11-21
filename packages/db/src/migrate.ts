// Forward-only SQL migrations for both planes. A migration is a `.sql` file in `<workspace>/migrations/<plane>/`;
// files apply in name order, directories in the order given, and each is recorded once in `schema_migrations`
// under `<workspace>/<file>`. Everything applies in one transaction under an advisory lock, so concurrent
// migrators (several service replicas starting together) serialize and a failure leaves nothing half applied.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ControlDb, TenantDb } from "./handles.ts";
import type { TenantPools } from "./pools.ts";

// Arbitrary constant namespacing Kerby's migration lock among other advisory locks.
const LOCK_KEY = 7_265_890_001;

export type Migration = { name: string; sql: string };

/** The migrations in `dirs`, in apply order. A directory must look like `<workspace>/migrations/<plane>`. */
export function readMigrations(dirs: readonly string[]): Migration[] {
  const found: Migration[] = [];
  for (const dir of dirs) {
    const absolute = resolve(dir);
    if (basename(dirname(absolute)) !== "migrations") {
      throw new Error(
        `migration directory ${dir} is not <workspace>/migrations/<plane>. Fix: keep SQL in migrations/control/ or migrations/tenant/ of the owning workspace. See ARCHITECTURE.md#tenancy`,
      );
    }
    const owner = basename(dirname(dirname(absolute)));
    const files = readdirSync(absolute)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      found.push({ name: `${owner}/${file}`, sql: readFileSync(join(absolute, file), "utf8") });
    }
  }
  const seen = new Set<string>();
  for (const { name } of found) {
    if (seen.has(name)) throw new Error(`migration ${name} appears in two directories`);
    seen.add(name);
  }
  return found;
}

/** Apply every migration not yet recorded. Returns the names applied by this call. */
export async function migrate(
  db: ControlDb | TenantDb,
  dirs: readonly string[],
): Promise<string[]> {
  const migrations = readMigrations(dirs);
  // The transaction type differs per plane; both expose the same `query`, which is all this needs.
  const transaction = db.transaction.bind(db) as (
    fn: (tx: Pick<ControlDb, "query">) => Promise<string[]>,
  ) => Promise<string[]>;
  return transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await tx.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await tx.query<{ name: string }>("select name from schema_migrations")).rows.map(
        (row) => row.name,
      ),
    );
    const applied: string[] = [];
    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      try {
        await tx.query(migration.sql);
      } catch (error) {
        throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      await tx.query("insert into schema_migrations (name) values ($1)", [migration.name]);
      applied.push(migration.name);
    }
    return applied;
  });
}

export type FanOutResult = {
  migrated: string[];
  failed: { tenantId: string; error: Error }[];
};

/**
 * Migrate many tenant databases, `concurrency` at a time (default 20, the sweep size measured in plan 0001).
 * One tenant failing does not stop the others: failures are returned for the caller to record and retry.
 */
export async function migrateTenants(
  pools: TenantPools,
  tenantIds: readonly string[],
  dirs: readonly string[],
  options: { concurrency?: number } = {},
): Promise<FanOutResult> {
  readMigrations(dirs); // fail once, up front, on a bad directory
  const result: FanOutResult = { migrated: [], failed: [] };
  const queue = [...tenantIds];
  const worker = async () => {
    for (let tenantId = queue.shift(); tenantId !== undefined; tenantId = queue.shift()) {
      try {
        await pools.use(tenantId, (db) => migrate(db, dirs));
        result.migrated.push(tenantId);
      } catch (error) {
        result.failed.push({ tenantId, error: error as Error });
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 20 }, worker));
  return result;
}
