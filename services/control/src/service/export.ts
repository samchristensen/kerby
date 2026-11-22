import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, tenantDbUrl } from "@kerby/control-plane";
import { dumpDatabase } from "@kerby/db";
import type { ControlDeps } from "../types/index.ts";
import { getTenantRecord } from "./tenants.ts";

export type TenantExport = {
  dumpFile: string;
  objectsFile: string;
  objectPrefix: string;
  objectCount: number;
};

/**
 * Export a tenant: a `pg_dump` of its database and a listing of its objects, in the export directory. Plan 0001 M9
 * verifies a restore; today the files are what an operator hands over.
 */
export async function exportTenant(deps: ControlDeps, tenantId: string): Promise<TenantExport> {
  const tenant = await getTenantRecord(deps, tenantId);
  const { settings, blobs } = deps;
  await mkdir(settings.exportDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const base = join(settings.exportDir, `${tenant.name}-${tenant.id.slice(0, 8)}-${stamp}`);
  const dumpFile = `${base}.dump`;
  const objectsFile = `${base}.objects.json`;

  await dumpDatabase(
    tenantDbUrl(tenant, settings.tenantDbSecret, settings.tenantDbSslmode),
    dumpFile,
    settings.pgDumpPath,
  );
  const objects = await blobs.listPrefix(tenant.id);
  await writeFile(objectsFile, JSON.stringify(objects, null, 2));
  await audit(deps.control, {
    tenantId,
    actor: "operator",
    action: "tenant.export",
    detail: { objectCount: objects.length },
  });
  return { dumpFile, objectsFile, objectPrefix: `t/${tenant.id}/`, objectCount: objects.length };
}
