import { copyObjects, tenantPrefix } from "@kerby/blobs";
import { audit, listTenants, type TenantRecord } from "@kerby/control-plane";
import { alert, errorFields, log, withTenant } from "@kerby/observability";
import { ConflictError, type ControlDeps } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

/** Arbitrary constant namespacing the bucket backup's advisory lock among Kerby's others. */
export const BACKUP_LOCK_KEY = 7_265_890_013;

type Failure = { tenantId: string; error: string };
export type BackupRun = {
  tenants: number;
  copied: number;
  bytes: number;
  unchanged: number;
  deletedTenants: number;
  objectsDeleted: number;
  failed: Failure[];
  durationMs: number;
};
export type RestoreRun = {
  tenants: number;
  restored: number;
  bytes: number;
  failed: Failure[];
  durationMs: number;
};

const live = (tenant: TenantRecord) => tenant.status === "active" || tenant.status === "suspended";

/**
 * Run `fn` while holding the backup lock, so one control instance at a time copies between the buckets. The lock is
 * a transaction-scoped advisory lock: it goes away with the connection if this process dies.
 */
async function exclusively<T>(deps: ControlDeps, fn: () => Promise<T>): Promise<T> {
  return deps.control.transaction(async (tx) => {
    const { rows } = await tx.query<{ locked: boolean }>(
      "select pg_try_advisory_xact_lock($1) as locked",
      [BACKUP_LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      throw new ConflictError(
        "a bucket backup or restore is already running on a control instance; retry when it finishes",
      );
    }
    return fn();
  });
}

/**
 * Copy the primary bucket's `t/` to the backup bucket, tenant by tenant: objects missing there or differing in size or
 * ETag. Objects only in the backup stay (they are what a restore brings back), except a deleted tenant's, which are
 * removed (the deletion obligation). A tenant without a row is left alone: after a control database restore, its
 * copy may be the only one. Failures are reported per tenant and do not stop the others.
 */
export async function backupBuckets(deps: ControlDeps): Promise<BackupRun> {
  return exclusively(deps, async () => {
    const started = performance.now();
    const run: BackupRun = {
      tenants: 0,
      copied: 0,
      bytes: 0,
      unchanged: 0,
      deletedTenants: 0,
      objectsDeleted: 0,
      failed: [],
      durationMs: 0,
    };
    const { primary, backup } = deps.buckets;
    for (const tenant of await listTenants(deps.control)) {
      const prefix = tenantPrefix(tenant.id);
      try {
        if (live(tenant)) {
          const copy = await copyObjects(primary, backup, prefix, "changed");
          run.tenants++;
          run.copied += copy.copied;
          run.bytes += copy.bytes;
          run.unchanged += copy.unchanged;
        } else if (tenant.status === "deleted") {
          const deleted = await backup.deletePrefix(prefix);
          if (deleted > 0) run.deletedTenants++;
          run.objectsDeleted += deleted;
        }
      } catch (error) {
        withTenant(tenant.id, () => log("error", "bucket backup failed", errorFields(error)));
        run.failed.push({
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    run.durationMs = Math.round(performance.now() - started);
    const { failed, ...counts } = run;
    log("info", "bucket backup ran", { ...counts, failed: failed.length, bucket: backup.name });
    if (failed.length > 0) {
      // One alert per run: the per-tenant lines above say which tenants and why.
      alert("bucket backup failed", {
        failed: failed.length,
        firstFailedTenant: failed[0]?.tenantId,
      });
    }
    return run;
  });
}

/**
 * Copy objects missing from the primary bucket back from the backup, for one tenant or every live one. Nothing in the
 * primary is overwritten, so a restore is safe to repeat and to run while tenants work.
 */
export async function restoreFromBackup(deps: ControlDeps, tenantId?: string): Promise<RestoreRun> {
  const tenants =
    tenantId === undefined
      ? (await listTenants(deps.control)).filter(live)
      : [await getTenantRecord(deps, tenantId)];
  return exclusively(deps, async () => {
    const started = performance.now();
    const run: RestoreRun = { tenants: 0, restored: 0, bytes: 0, failed: [], durationMs: 0 };
    const { primary, backup } = deps.buckets;
    for (const tenant of tenants) {
      try {
        const copy = await copyObjects(backup, primary, tenantPrefix(tenant.id), "missing");
        run.tenants++;
        run.restored += copy.copied;
        run.bytes += copy.bytes;
        await audit(deps.control, {
          tenantId: tenant.id,
          actor: "operator",
          action: "tenant.restore_objects",
          detail: { restored: copy.copied, bytes: copy.bytes },
        });
      } catch (error) {
        withTenant(tenant.id, () => log("error", "bucket restore failed", errorFields(error)));
        run.failed.push({
          tenantId: tenant.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    run.durationMs = Math.round(performance.now() - started);
    const { failed, ...counts } = run;
    log(failed.length > 0 ? "error" : "info", "bucket restore ran", {
      ...counts,
      failed: failed.length,
    });
    return run;
  });
}
