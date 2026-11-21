import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { type Blobs, createBlobs } from "./index.ts";

// One bucket per test process; tenants isolate by prefix, and every test uses fresh tenant ids.
let bucket: Promise<Blobs> | undefined;

/** Blobs on the test RustFS, bucket created on first use. */
export function createTestBlobs(): Promise<Blobs> {
  bucket ??= (async () => {
    const { endpoint, accessKeyId, secretAccessKey } = inject("containers").s3;
    const blobs = createBlobs({
      endpoint,
      bucket: `kt-${randomBytes(4).toString("hex")}`,
      credentials: { accessKeyId, secretAccessKey },
    });
    await blobs.ensureBucket();
    return blobs;
  })();
  return bucket;
}
