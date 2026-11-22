import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantPrefix } from "@kerby/blobs";
import { audit, tenantDbUrl } from "@kerby/control-plane";
import { dumpDatabase } from "@kerby/db";
import { log } from "@kerby/observability";
import type { ControlDeps } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

/** How long an export's download URLs work. */
export const EXPORT_URL_SECONDS = 24 * 60 * 60;
/** How long an export is kept, a deleted tenant's included (it may be the hand-over copy). Decided in ADR 0013. */
export const EXPORT_RETENTION_DAYS = 30;

export type TenantExport = {
  dumpUrl: string;
  objectsUrl: string;
  expiresAt: string;
  objectPrefix: string;
  objectCount: number;
};

// An export's keys are `<tenantId>/<stamp>.dump` and `<tenantId>/<stamp>.objects.json`; the stamp is the export's
// time by the injected clock (an ISO instant with `:` and `.` as `-`), which retention reads back.
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.(?:dump|objects\.json)$/;

function exportedAt(key: string): Date | undefined {
  const match = STAMP.exec(key.slice(key.indexOf("/") + 1));
  if (!match) return undefined;
  const [, day, hours, minutes, seconds, millis] = match;
  return new Date(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
}

/**
 * Export a tenant: a `pg_dump` of its database and a listing of its objects, uploaded to the export bucket, returned as
 * presigned download URLs. The dump passes through a temporary file, removed whether or not the upload succeeds.
 * Plan 0001 M9 verifies a restore; today the files are what an operator hands over.
 */
export async function exportTenant(deps: ControlDeps, tenantId: string): Promise<TenantExport> {
  const tenant = await getTenantRecord(deps, tenantId);
  const { settings, buckets } = deps;
  const at = deps.now();
  const base = `${tenant.id}/${at.toISOString().replaceAll(/[:.]/g, "-")}`;
  const dumpKey = `${base}.dump`;
  const objectsKey = `${base}.objects.json`;

  const dir = await mkdtemp(join(tmpdir(), "kerby-export-"));
  try {
    const file = join(dir, "tenant.dump");
    await dumpDatabase(
      tenantDbUrl(tenant, settings.tenantDbSecret, settings.tenantDbSslmode),
      file,
      settings.pgDumpPath,
    );
    await buckets.exports.uploadFile(dumpKey, file, "application/octet-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const prefix = tenantPrefix(tenant.id);
  const objects: { key: string; size: number }[] = [];
  for await (const object of buckets.primary.list(prefix)) {
    objects.push({ key: object.key.slice(prefix.length), size: object.size });
  }
  await buckets.exports.write(
    objectsKey,
    new TextEncoder().encode(JSON.stringify(objects, null, 2)),
    "application/json",
  );

  const expiresAt = new Date(at.getTime() + EXPORT_URL_SECONDS * 1000).toISOString();
  const presign = (key: string) =>
    buckets.exports.presignGet(key, { expiresInSeconds: EXPORT_URL_SECONDS, signedAt: at });
  const [dumpUrl, objectsUrl] = [await presign(dumpKey), await presign(objectsKey)];

  await audit(deps.control, {
    tenantId,
    actor: "operator",
    action: "tenant.export",
    detail: { objectCount: objects.length },
  });
  // Each URL is a credential to the tenant's data until it expires: record that it was issued.
  for (const key of [dumpKey, objectsKey]) {
    await audit(deps.control, {
      tenantId,
      actor: "operator",
      action: "export.url_issued",
      detail: { key, expiresAt },
    });
  }
  return { dumpUrl, objectsUrl, expiresAt, objectPrefix: prefix, objectCount: objects.length };
}

/**
 * Delete exports older than `EXPORT_RETENTION_DAYS`, by the stamp in their key. Railway buckets have no lifecycle
 * rules, so control does this at startup and daily. Every control instance may run it: deleting twice is harmless.
 */
export async function deleteExpiredExports(deps: ControlDeps): Promise<number> {
  const cutoff = deps.now().getTime() - EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for await (const object of deps.buckets.exports.list("")) {
    const at = exportedAt(object.key);
    if (at === undefined) {
      log("warn", "export retention skipped a key it cannot date", { key: object.key });
    } else if (at.getTime() < cutoff) {
      expired.push(object.key);
    }
  }
  await deps.buckets.exports.deleteKeys(expired);
  log("info", "export retention ran", { deleted: expired.length });
  return expired.length;
}
