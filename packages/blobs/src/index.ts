// Object storage behind one door (ADR 0002). Tenant code goes through `Blobs`, which takes a tenant context on every
// call: the object key is `t/<tenantId>/<key>`, and the tenant's own `blobs` table is the index. The object is written
// first, then the index row, so a crash between them leaves an orphan object (swept in M8), never an index row without
// bytes. `Bucket` (./bucket.ts) is the operator's raw-key access, for `control` only.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { TenantContext } from "@kerby/db";
import { type BucketConfig, createBucket, createS3Client, tenantPrefix } from "./bucket.ts";

export {
  type Bucket,
  type BucketConfig,
  copyObjects,
  createBucket,
  tenantPrefix,
} from "./bucket.ts";

/** Blob index migration, a tenant migration applied after Absurd's. */
export const blobsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

type PutBlob = {
  /** What it is: `message`, `attachment`, ... Free-form, for the index. */
  kind: string;
  /** Deterministic, relative to the tenant's prefix, e.g. `conversations/<id>/messages/000007.json`. A retry overwrites. */
  key: string;
  body: Uint8Array;
  mediaType: string;
  conversationId?: string;
};

type BlobRef = { blobId: string; size: number; sha256: string };
type BlobObject = { body: Uint8Array; mediaType: string; size: number };

export class BlobNotFoundError extends Error {
  override name = "BlobNotFoundError";
}

const KEY = /^[A-Za-z0-9._=:-]+(?:\/[A-Za-z0-9._=:-]+)*$/;

function objectKey(tenantId: string, key: string): string {
  if (
    key.length > 512 ||
    !KEY.test(key) ||
    key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      `invalid blob key "${key}": use [A-Za-z0-9._=:-] segments separated by "/", no "." or ".." segments`,
    );
  }
  return tenantPrefix(tenantId) + key;
}

export interface Blobs {
  put(ctx: TenantContext, blob: PutBlob): Promise<BlobRef>;
  /** Looks the id up in the context's own index first; an id from another tenant is simply not found. */
  get(ctx: TenantContext, blobId: string): Promise<BlobObject>;
  /** Create the bucket if it does not exist (local stacks and tests; production buckets are provisioned). */
  ensureBucket(): Promise<void>;
}

export function createBlobs(config: BucketConfig): Blobs {
  const s3 = createS3Client(config);
  const Bucket = config.bucket;

  return {
    async put(ctx, blob) {
      const Key = objectKey(ctx.tenantId, blob.key);
      const sha256 = createHash("sha256").update(blob.body).digest("hex");
      await s3.send(
        new PutObjectCommand({ Bucket, Key, Body: blob.body, ContentType: blob.mediaType }),
      );
      const { rows } = await ctx.db.query<{ id: string }>(
        `insert into blobs (object_key, kind, media_type, size, sha256, conversation_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (object_key) do update
           set kind = excluded.kind, media_type = excluded.media_type, size = excluded.size,
               sha256 = excluded.sha256, conversation_id = excluded.conversation_id
         returning id`,
        [Key, blob.kind, blob.mediaType, blob.body.byteLength, sha256, blob.conversationId ?? null],
      );
      const row = rows[0];
      if (!row) throw new Error("blob index insert returned no row");
      return { blobId: row.id, size: blob.body.byteLength, sha256 };
    },

    async get(ctx, blobId) {
      const { rows } = await ctx.db.query<{ object_key: string; media_type: string; size: string }>(
        "select object_key, media_type, size from blobs where id::text = $1",
        [blobId],
      );
      const row = rows[0];
      if (!row) throw new BlobNotFoundError(`blob ${blobId} not found`);
      // A context pairing one tenant's id with another's database must not read across.
      if (!row.object_key.startsWith(tenantPrefix(ctx.tenantId))) {
        throw new BlobNotFoundError(`blob ${blobId} does not belong to this tenant`);
      }
      const object = await s3.send(new GetObjectCommand({ Bucket, Key: row.object_key }));
      if (!object.Body) throw new Error(`object ${row.object_key} has no body`);
      return {
        body: await object.Body.transformToByteArray(),
        mediaType: row.media_type,
        size: Number(row.size),
      };
    },

    ensureBucket: () => createBucket(config).ensureBucket(),
  };
}
