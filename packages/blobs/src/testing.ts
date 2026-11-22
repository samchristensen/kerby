import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { type Blobs, type Bucket, type BucketConfig, createBlobs, createBucket } from "./index.ts";

function testBucketConfig(bucket: string): BucketConfig {
  const { endpoint, accessKeyId, secretAccessKey } = inject("containers").s3;
  return { endpoint, bucket, credentials: { accessKeyId, secretAccessKey } };
}

// One shared bucket per test process; tenants isolate by prefix, and every test uses fresh tenant ids.
let shared: Promise<BucketConfig> | undefined;
const sharedConfig = () => {
  shared ??= (async () => {
    const config = testBucketConfig(`kt-${randomBytes(4).toString("hex")}`);
    await createBucket(config).ensureBucket();
    return config;
  })();
  return shared;
};

/** Blobs on the test RustFS, bucket created on first use. */
export async function createTestBlobs(): Promise<Blobs> {
  return createBlobs(await sharedConfig());
}

/** The bucket `createTestBlobs` writes to, by raw key (the operator's view of it). */
export async function createTestBucket(): Promise<Bucket> {
  return createBucket(await sharedConfig());
}

/** A new, empty bucket on the test RustFS (an export or backup bucket). */
export async function createEmptyTestBucket(): Promise<Bucket> {
  const bucket = createBucket(testBucketConfig(`kt-${randomBytes(6).toString("hex")}`));
  await bucket.ensureBucket();
  return bucket;
}
