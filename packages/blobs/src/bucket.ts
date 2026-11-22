// Operator access to a whole bucket by raw key, for `control` only: tenant prefixes (export, deletion), the export
// bucket and the backup copy. Tenant code reaches objects through `Blobs`, which takes a tenant context instead.
import { open } from "node:fs/promises";
import {
  AbortMultipartUploadCommand,
  type CompletedPart,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type BucketConfig = {
  /** The S3-compatible endpoint: a Railway bucket, or RustFS locally. */
  endpoint: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Defaults to `us-east-1`; RustFS ignores it and Railway buckets use `auto`. */
  region?: string | undefined;
};

export type StoredObject = { key: string; size: number; etag: string };

const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Every object of a tenant lives under this prefix, in the primary bucket and in its backup copy. */
export function tenantPrefix(tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("invalid tenant id for an object prefix");
  return `t/${tenantId}/`;
}

/** Parts of a multipart upload. 10,000 parts (the S3 maximum) of this size cap one upload at 320 GiB. */
const PART_BYTES = 32 * 1024 * 1024;
/** SigV4 refuses a presigned URL valid for longer than seven days. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface Bucket {
  readonly name: string;
  /** Every object whose key starts with `prefix`, with full keys, in key order. */
  list(prefix: string): AsyncGenerator<StoredObject>;
  read(key: string): Promise<{ body: Uint8Array; mediaType: string | undefined }>;
  write(key: string, body: Uint8Array, mediaType: string): Promise<void>;
  /** Upload a local file in parts, so its size is not capped by a single put (5 GiB). Returns its size in bytes. */
  uploadFile(key: string, path: string, mediaType: string): Promise<number>;
  /** A URL that downloads `key` without credentials until `signedAt + expiresInSeconds`. */
  presignGet(key: string, options: { expiresInSeconds: number; signedAt: Date }): Promise<string>;
  deleteKeys(keys: readonly string[]): Promise<void>;
  /** Delete every object under `prefix`. Returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  /** Create the bucket if it does not exist (local stacks and tests; production buckets are provisioned). */
  ensureBucket(): Promise<void>;
}

export function createS3Client(config: BucketConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region ?? "us-east-1",
    credentials: config.credentials,
    // Path-style addressing works on every S3-compatible server we run against.
    forcePathStyle: true,
  });
}

export function createBucket(config: BucketConfig): Bucket {
  const s3 = createS3Client(config);
  const Bucket = config.bucket;

  const deleteKeys = async (keys: readonly string[]) => {
    // DeleteObjects takes at most 1000 keys.
    for (let start = 0; start < keys.length; start += 1000) {
      const Objects = keys.slice(start, start + 1000).map((Key) => ({ Key }));
      const result = await s3.send(
        new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }),
      );
      if (result.Errors?.length) {
        throw new Error(`deleting objects in ${Bucket} failed for ${result.Errors.length} keys`);
      }
    }
  };

  async function* list(Prefix: string): AsyncGenerator<StoredObject> {
    let ContinuationToken: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
      for (const object of page.Contents ?? []) {
        if (object.Key) {
          yield { key: object.Key, size: object.Size ?? 0, etag: object.ETag ?? "" };
        }
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  return {
    name: Bucket,
    list,

    async read(Key) {
      const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
      if (!object.Body) throw new Error(`object ${Key} in ${Bucket} has no body`);
      return { body: await object.Body.transformToByteArray(), mediaType: object.ContentType };
    },

    async write(Key, body, mediaType) {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: mediaType }));
    },

    async uploadFile(Key, path, mediaType) {
      const file = await open(path, "r");
      const { UploadId } = await s3.send(
        new CreateMultipartUploadCommand({ Bucket, Key, ContentType: mediaType }),
      );
      if (!UploadId) throw new Error(`no upload id for ${Key} in ${Bucket}`);
      try {
        const parts: CompletedPart[] = [];
        let size = 0;
        // One part at a time keeps memory at one part; every part but the last is full size, as S3 requires.
        for (let PartNumber = 1; ; PartNumber++) {
          const chunk = Buffer.allocUnsafe(PART_BYTES);
          let filled = 0;
          while (filled < PART_BYTES) {
            const { bytesRead } = await file.read(chunk, filled, PART_BYTES - filled, null);
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          // An empty file still needs one (empty) part.
          if (filled === 0 && PartNumber > 1) break;
          const uploaded = await s3.send(
            new UploadPartCommand({
              Bucket,
              Key,
              UploadId,
              PartNumber,
              Body: chunk.subarray(0, filled),
            }),
          );
          parts.push({
            PartNumber,
            ETag: uploaded.ETag,
            ChecksumCRC32: uploaded.ChecksumCRC32,
          });
          size += filled;
          if (filled < PART_BYTES) break;
        }
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
        return size;
      } catch (error) {
        await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
        throw error;
      } finally {
        await file.close();
      }
    },

    async presignGet(Key, { expiresInSeconds, signedAt }) {
      if (
        !Number.isInteger(expiresInSeconds) ||
        expiresInSeconds < 1 ||
        expiresInSeconds > MAX_PRESIGN_SECONDS
      ) {
        throw new Error(`a presigned URL lives 1 to ${MAX_PRESIGN_SECONDS} seconds`);
      }
      return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), {
        expiresIn: expiresInSeconds,
        signingDate: signedAt,
      });
    },

    deleteKeys,

    async deletePrefix(prefix) {
      if (prefix === "") throw new Error("refusing to delete a whole bucket: name a prefix");
      // Collect first: deleting while paging would shift the listing under the continuation token.
      const keys: string[] = [];
      for await (const object of list(prefix)) keys.push(object.key);
      await deleteKeys(keys);
      return keys.length;
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

export type CopySummary = { copied: number; bytes: number; unchanged: number };

/**
 * Copy the objects under `prefix` from one bucket to another, which may sit on another endpoint with other keys (so
 * the bytes pass through this process). `changed` copies objects missing from the target or differing in size or
 * ETag (the backup); `missing` copies only objects the target lacks (a restore never overwrites). Objects only in the
 * target stay.
 */
export async function copyObjects(
  from: Bucket,
  to: Bucket,
  prefix: string,
  mode: "changed" | "missing",
  concurrency = 8,
): Promise<CopySummary> {
  const existing = new Map<string, StoredObject>();
  for await (const object of to.list(prefix)) existing.set(object.key, object);
  const pending: StoredObject[] = [];
  let unchanged = 0;
  for await (const object of from.list(prefix)) {
    const there = existing.get(object.key);
    const same =
      there !== undefined &&
      (mode === "missing" || (there.size === object.size && there.etag === object.etag));
    if (same) unchanged++;
    else pending.push(object);
  }
  let copied = 0;
  let bytes = 0;
  const copyNext = async (): Promise<void> => {
    try {
      for (let object = pending.pop(); object; object = pending.pop()) {
        const { body, mediaType } = await from.read(object.key);
        await to.write(object.key, body, mediaType ?? "application/octet-stream");
        copied++;
        bytes += body.byteLength;
      }
    } catch (error) {
      pending.length = 0; // the other workers stop after their current object
      throw error;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, copyNext));
  return { copied, bytes, unchanged };
}
