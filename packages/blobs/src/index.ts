// Object storage behind one door (ADR 0002). Every call takes a tenant context: the object key is
// `t/<tenantId>/<key>`, and the tenant's own `blobs` table is the index. The object is written first, then
// the index row, so a crash between them leaves an orphan object (swept in M8), never an index row without bytes.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { TenantContext } from "@kerby/db";

/** Blob index migration, a tenant migration applied after Absurd's. */
export const blobsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

export type BlobsConfig = {
  /** A custom S3-compatible endpoint (RustFS locally). Omit for AWS S3. */
  endpoint?: string | undefined;
  bucket: string;
  /** Static credentials (local stacks). Omit on AWS: the SDK uses the task or instance role. */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** Omit on AWS: the SDK reads the region from its environment. */
  region?: string | undefined;
};

export type PutBlob = {
  /** What it is: `message`, `attachment`, ... Free-form, for the index. */
  kind: string;
  /** Deterministic, relative to the tenant's prefix, e.g. `conversations/<id>/messages/000007.json`. A retry overwrites. */
  key: string;
  body: Uint8Array;
  mediaType: string;
  conversationId?: string;
};

export type BlobRef = { blobId: string; size: number; sha256: string };
export type BlobObject = { body: Uint8Array; mediaType: string; size: number };

export class BlobNotFoundError extends Error {
  override name = "BlobNotFoundError";
}

const KEY = /^[A-Za-z0-9._=:-]+(?:\/[A-Za-z0-9._=:-]+)*$/;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/;

function prefix(tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("invalid tenant id for an object prefix");
  return `t/${tenantId}/`;
}

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
  return prefix(tenantId) + key;
}

export interface Blobs {
  put(ctx: TenantContext, blob: PutBlob): Promise<BlobRef>;
  /** Looks the id up in the context's own index first; an id from another tenant is simply not found. */
  get(ctx: TenantContext, blobId: string): Promise<BlobObject>;
  /** Every object under the tenant's prefix, keys relative to it (tenant export). */
  listPrefix(tenantId: string): Promise<{ key: string; size: number }[]>;
  /** Delete every object of a tenant (tenant deletion). Returns how many. */
  deletePrefix(tenantId: string): Promise<number>;
  /** Create the bucket if it does not exist (local stacks and tests; production buckets are provisioned). */
  ensureBucket(): Promise<void>;
}

export function createBlobs(config: BlobsConfig): Blobs {
  const s3 = new S3Client({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.endpoint
      ? { region: config.region ?? "us-east-1" }
      : config.region
        ? { region: config.region }
        : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
    // Custom endpoints (RustFS, MinIO) need path-style; AWS S3 uses virtual-hosted style.
    forcePathStyle: config.endpoint !== undefined,
  });
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
      if (!row.object_key.startsWith(prefix(ctx.tenantId))) {
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

    async listPrefix(tenantId) {
      const Prefix = prefix(tenantId);
      const found: { key: string; size: number }[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const object of page.Contents ?? []) {
          if (object.Key)
            found.push({ key: object.Key.slice(Prefix.length), size: object.Size ?? 0 });
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return found;
    },

    async deletePrefix(tenantId) {
      const Prefix = prefix(tenantId);
      let deleted = 0;
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        const keys = (page.Contents ?? []).flatMap((object) =>
          object.Key ? [{ Key: object.Key }] : [],
        );
        if (keys.length > 0) {
          const result = await s3.send(
            new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }),
          );
          if (result.Errors?.length)
            throw new Error(
              `deleting objects under ${Prefix} failed for ${result.Errors.length} keys`,
            );
          deleted += keys.length;
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return deleted;
    },

    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket }));
      }
    },
  };
}
