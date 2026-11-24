// Access to the whole bucket by raw key, for `control` only: it creates the bucket and deletes a tenant's prefix. Tenant
// code reaches objects through `Blobs`, which takes a tenant context instead.
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export type BucketConfig = {
  /** The S3-compatible endpoint: a Railway bucket, or RustFS locally. */
  endpoint: string;
  bucket: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Defaults to `us-east-1`; RustFS ignores it and Railway buckets use `auto`. */
  region?: string | undefined;
};

type StoredObject = { key: string; size: number; etag: string };

const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Every object of a tenant lives under this prefix. */
export function tenantPrefix(tenantId: string): string {
  if (!TENANT_ID.test(tenantId)) throw new Error("invalid tenant id for an object prefix");
  return `t/${tenantId}/`;
}

export interface Bucket {
  readonly name: string;
  /** Every object whose key starts with `prefix`, with full keys, in key order. */
  list(prefix: string): AsyncGenerator<StoredObject>;
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
