import { describe, expect, it } from "vitest";
import {
  createOpener,
  createSealer,
  createSecretBox,
  generateBoxKey,
  generateSecretsKeyPair,
  publicKeyOf,
  SecretsError,
  secretContext,
} from "./index.ts";

const ctx = secretContext("tenant-a", "model-key/anthropic");

describe("sealed secrets", () => {
  it("round-trips, and never stores the plaintext", () => {
    const pair = generateSecretsKeyPair();
    const sealed = createSealer(pair.publicKey).seal("sk-ant-very-secret", ctx);
    expect(sealed.includes(Buffer.from("sk-ant-very-secret"))).toBe(false);
    expect(createOpener([pair.privateKey]).open(sealed, ctx)).toBe("sk-ant-very-secret");
  });

  it("seals the same secret differently each time", () => {
    const pair = generateSecretsKeyPair();
    const sealer = createSealer(pair.publicKey);
    expect(sealer.seal("x", ctx).equals(sealer.seal("x", ctx))).toBe(false);
  });

  it("refuses a ciphertext moved to another tenant or name", () => {
    const pair = generateSecretsKeyPair();
    const sealed = createSealer(pair.publicKey).seal("sk", ctx);
    const opener = createOpener([pair.privateKey]);
    expect(() => opener.open(sealed, secretContext("tenant-b", "model-key/anthropic"))).toThrow(
      SecretsError,
    );
    expect(() => opener.open(sealed, secretContext("tenant-a", "model-key/openai"))).toThrow(
      SecretsError,
    );
  });

  it("refuses altered bytes in any position", () => {
    const pair = generateSecretsKeyPair();
    const sealed = createSealer(pair.publicKey).seal("sk", ctx);
    const opener = createOpener([pair.privateKey]);
    for (const index of [0, 5, 20, 45, sealed.length - 20, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[index] = (copy[index] ?? 0) ^ 1;
      expect(() => opener.open(copy, ctx)).toThrow(SecretsError);
    }
    expect(() => opener.open(sealed.subarray(0, 10), ctx)).toThrow(SecretsError);
  });

  it("opens after a rotation while the old key is kept, and not without it", () => {
    const oldPair = generateSecretsKeyPair();
    const newPair = generateSecretsKeyPair();
    const sealedOld = createSealer(oldPair.publicKey).seal("old", ctx);
    const sealedNew = createSealer(newPair.publicKey).seal("new", ctx);
    const both = createOpener([newPair.privateKey, oldPair.privateKey]);
    expect(both.open(sealedOld, ctx)).toBe("old");
    expect(both.open(sealedNew, ctx)).toBe("new");
    expect(() => createOpener([newPair.privateKey]).open(sealedOld, ctx)).toThrow(SecretsError);
  });

  it("derives the public key of a private key", () => {
    const pair = generateSecretsKeyPair();
    expect(publicKeyOf(pair.privateKey)).toBe(pair.publicKey);
  });

  it("rejects malformed keys without echoing them", () => {
    expect(() => createSealer("not-a-key")).toThrow(/32 bytes/);
    expect(() => createOpener([])).toThrow(SecretsError);
  });
});

describe("secret box", () => {
  const owner = "kerby-tenant-db:tenant-a";

  it("round-trips, never stores the plaintext, and seals differently each time", () => {
    const box = createSecretBox([generateBoxKey()]);
    const sealed = box.seal("db-password", owner);
    expect(sealed.includes(Buffer.from("db-password"))).toBe(false);
    expect(box.open(sealed, owner)).toBe("db-password");
    expect(box.seal("db-password", owner).equals(sealed)).toBe(false);
  });

  it("refuses a ciphertext moved to another owner, altered bytes, and a sealed-pair ciphertext", () => {
    const box = createSecretBox([generateBoxKey()]);
    const sealed = box.seal("db-password", owner);
    expect(() => box.open(sealed, "kerby-tenant-db:tenant-b")).toThrow(SecretsError);
    for (const index of [0, 3, 15, sealed.length - 20, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[index] = (copy[index] ?? 0) ^ 1;
      expect(() => box.open(copy, owner)).toThrow(SecretsError);
    }
    const pair = generateSecretsKeyPair();
    expect(() => box.open(createSealer(pair.publicKey).seal("x", owner), owner)).toThrow(
      "not a secret box ciphertext",
    );
  });

  it("seals with the first key, opens with any, and says what needs re-sealing", () => {
    const oldKey = generateBoxKey();
    const newKey = generateBoxKey();
    const sealedOld = createSecretBox([oldKey]).seal("old", owner);
    const rotating = createSecretBox([newKey, oldKey]);
    expect(rotating.open(sealedOld, owner)).toBe("old");
    expect(rotating.sealedWithCurrentKey(sealedOld)).toBe(false);
    const resealed = rotating.seal(rotating.open(sealedOld, owner), owner);
    expect(rotating.sealedWithCurrentKey(resealed)).toBe(true);
    expect(createSecretBox([newKey]).open(resealed, owner)).toBe("old");
    expect(() => createSecretBox([newKey]).open(sealedOld, owner)).toThrow(/does not hold/);
  });

  it("rejects a missing or malformed key without echoing it", () => {
    expect(() => createSecretBox([], "TENANT_DB_KEYS key")).toThrow(
      /at least one TENANT_DB_KEYS key/,
    );
    expect(() => createSecretBox(["c2hvcnQ="])).toThrow(/32 bytes/);
    try {
      createSecretBox(["c2hvcnQ="]);
    } catch (error) {
      expect(String(error)).not.toContain("c2hvcnQ=");
    }
  });
});
