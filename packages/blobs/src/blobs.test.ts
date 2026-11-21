import { randomUUID } from "node:crypto";
import { type ClosableTenantDb, createTenantDb, type TenantContext } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { BlobNotFoundError, blobsMigrationsDir } from "./index.ts";
import { createTestBlobs } from "./testing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tenant(
  tenantId: string = randomUUID(),
): Promise<TenantContext & { db: ClosableTenantDb }> {
  const database = await createMigratedDatabase([blobsMigrationsDir]);
  const db = createTenantDb(database.url);
  cleanups.push(async () => {
    await db.close();
    await database.drop();
  });
  return { tenantId, db };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("blobs", () => {
  it("puts and gets a blob, recording it in the tenant's index", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    const ref = await blobs.put(a, {
      kind: "message",
      key: "conversations/c1/messages/000001.json",
      body: bytes('{"hello":"world"}'),
      mediaType: "application/json",
    });
    expect(ref.size).toBe(17);
    const got = await blobs.get(a, ref.blobId);
    expect(text(got.body)).toBe('{"hello":"world"}');
    expect(got.mediaType).toBe("application/json");
    const { rows } = await a.db.query("select kind, size::int as size, object_key from blobs");
    expect(rows).toEqual([
      {
        kind: "message",
        size: 17,
        object_key: `t/${a.tenantId}/conversations/c1/messages/000001.json`,
      },
    ]);
  });

  it("a retried put overwrites the object and keeps one index row and the same id", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    const put = (body: string) =>
      blobs.put(a, {
        kind: "message",
        key: "m/1.json",
        body: bytes(body),
        mediaType: "text/plain",
      });
    const first = await put("first");
    const second = await put("second, longer");
    expect(second.blobId).toBe(first.blobId);
    expect((await a.db.query("select 1 from blobs")).rowCount).toBe(1);
    expect(text((await blobs.get(a, first.blobId)).body)).toBe("second, longer");
  });

  it("does not let tenant A read tenant B's blob id", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    const b = await tenant();
    const secret = await blobs.put(b, {
      kind: "message",
      key: "m/1.json",
      body: bytes("b's"),
      mediaType: "text/plain",
    });
    await expect(blobs.get(a, secret.blobId)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("refuses a context that pairs one tenant's id with another tenant's database", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    const b = await tenant();
    const ref = await blobs.put(b, {
      kind: "message",
      key: "m/1.json",
      body: bytes("b's"),
      mediaType: "text/plain",
    });
    const swapped: TenantContext = { tenantId: a.tenantId, db: b.db };
    await expect(blobs.get(swapped, ref.blobId)).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("rejects keys that could leave the tenant's prefix", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    for (const key of [
      "../t/other/x",
      "/abs",
      "a//b",
      "a/../b",
      "a/./b",
      "",
      "a b",
      "x".repeat(600),
    ]) {
      await expect(
        blobs.put(a, { kind: "k", key, body: bytes("x"), mediaType: "text/plain" }),
      ).rejects.toThrow(/invalid blob key/);
    }
    await expect(
      blobs.put(
        { tenantId: "../other", db: a.db },
        { kind: "k", key: "ok", body: bytes("x"), mediaType: "text/plain" },
      ),
    ).rejects.toThrow(/invalid tenant id/);
  });

  it("stores a large body intact", async () => {
    const blobs = await createTestBlobs();
    const a = await tenant();
    const body = new Uint8Array(8 * 1024 * 1024).map((_, i) => i % 251);
    const ref = await blobs.put(a, {
      kind: "attachment",
      key: "big.bin",
      body,
      mediaType: "application/octet-stream",
    });
    const got = await blobs.get(a, ref.blobId);
    expect(got.size).toBe(body.byteLength);
    expect(Buffer.from(got.body).equals(Buffer.from(body))).toBe(true);
  });

  it("deletePrefix removes one tenant's objects and not a tenant whose id extends it", async () => {
    const blobs = await createTestBlobs();
    const id = randomUUID();
    const a = await tenant(id);
    const longer = await tenant(`${id}x`);
    const put = (ctx: TenantContext, key: string) =>
      blobs.put(ctx, { kind: "k", key, body: bytes(key), mediaType: "text/plain" });
    await put(a, "one");
    await put(a, "deep/two");
    const kept = await put(longer, "one");
    expect(await blobs.deletePrefix(id)).toBe(2);
    expect(text((await blobs.get(longer, kept.blobId)).body)).toBe("one");
    expect(await blobs.deletePrefix(id)).toBe(0);
  });
});
