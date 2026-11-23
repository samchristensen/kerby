// What a tenant stores, against `limits.storageBytes`: the blob index (message bodies and other objects) and the prompt
// bodies, drafts and versions (ADR 0017). The one count both message posts and prompt writes check.
import type { TenantQueryable } from "@kerby/db";

/** The tenant's stored bytes would pass its storage quota. */
export class StorageQuotaExceededError extends Error {
  override name = "StorageQuotaExceededError";
}

/** Bytes the tenant stores: its blob index, leaving out `exceptBlobId` (an object just written), plus its prompt bodies. */
export async function storedBytes(db: TenantQueryable, exceptBlobId?: string): Promise<number> {
  const { rows } = await db.query<{ bytes: string }>(
    `select ((select coalesce(sum(size), 0) from blobs where id is distinct from $1)
           + (select coalesce(sum(draft_bytes), 0) from prompts)
           + (select coalesce(sum(bytes), 0) from prompt_versions))::text as bytes`,
    [exceptBlobId ?? null],
  );
  return Number(rows[0]?.bytes ?? 0);
}
