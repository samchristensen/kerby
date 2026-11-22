// Sealed secrets for tenants' own credentials (model keys, tool auth). A secret is encrypted to a platform public
// key (X25519), so a process that only stores secrets (the api) holds the public key and cannot read them back; only
// the worker, which holds a private key, can open one, and only inside a run (ADR 0008).
//
// Each seal is an ephemeral X25519 key agreement, HKDF-SHA256, then AES-256-GCM, so every secret has its own data
// key. The `context` string (tenant id and secret name) is authenticated: a ciphertext copied to another tenant or
// name fails to open. Layout: version(1) | key id(8) | ephemeral public key(32) | nonce(12) | ciphertext | tag(16).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";

const VERSION = 1;
const KEY_ID_BYTES = 8;
const PUBLIC_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_ID_BYTES + PUBLIC_BYTES + NONCE_BYTES;
const INFO = Buffer.from("kerby-secrets-v1");

const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export class SecretsError extends Error {
  override name = "SecretsError";
}

/** The context binding a secret to its owner: pass the same value to `seal` and `open`. */
export const secretContext = (tenantId: string, name: string): string =>
  `kerby-secret:${tenantId}:${name}`;

function rawPublic(key: KeyObject): Buffer {
  const der = key.export({ type: "spki", format: "der" });
  return der.subarray(SPKI_PREFIX.length);
}

const keyId = (publicRaw: Buffer): Buffer =>
  createHash("sha256").update(publicRaw).digest().subarray(0, KEY_ID_BYTES);

function decodeKey(value: string, what: string): Buffer {
  const raw = Buffer.from(value.trim(), "base64");
  if (raw.length !== PUBLIC_BYTES) {
    throw new SecretsError(
      `${what} must be 32 bytes, base64 encoded (generate one: make secrets-key)`,
    );
  }
  return raw;
}

function deriveKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralPublic, recipientPublic]);
  return Buffer.from(hkdfSync("sha256", shared, salt, INFO, 32));
}

/** A new secrets key pair as base64 raw keys. Keep `privateKey` with the workers; give `publicKey` to the api. */
export function generateSecretsKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privateRaw = privateKey
    .export({ type: "pkcs8", format: "der" })
    .subarray(PKCS8_PREFIX.length);
  return {
    privateKey: Buffer.from(privateRaw).toString("base64"),
    publicKey: rawPublic(publicKey).toString("base64"),
  };
}

/** The public key (base64) of a private key (base64): what the api is given for the key a worker holds. */
export function publicKeyOf(privateKeyBase64: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, decodeKey(privateKeyBase64, "a secrets private key")]),
    format: "der",
    type: "pkcs8",
  });
  return rawPublic(createPublicKey(privateKey)).toString("base64");
}

export type Sealer = { seal(plaintext: string, context: string): Buffer };

/** Seals to one public key (base64, 32 bytes). Cannot open what it seals. */
export function createSealer(publicKeyBase64: string): Sealer {
  const recipientRaw = decodeKey(publicKeyBase64, "the secrets public key");
  const recipient = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, recipientRaw]),
    format: "der",
    type: "spki",
  });
  const id = keyId(recipientRaw);
  return {
    seal(plaintext, context) {
      const ephemeral = generateKeyPairSync("x25519");
      const ephemeralPublic = rawPublic(ephemeral.publicKey);
      const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
      const key = deriveKey(shared, ephemeralPublic, recipientRaw);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([
        Buffer.of(VERSION),
        id,
        ephemeralPublic,
        nonce,
        body,
        cipher.getAuthTag(),
      ]);
    },
  };
}

export type Opener = { open(sealed: Uint8Array, context: string): string };

/**
 * Opens with any of the given private keys (base64, 32 bytes). Put the key new secrets are sealed to first when
 * rotating, and keep the old one until every secret sealed to it is re-sealed.
 */
export function createOpener(privateKeysBase64: readonly string[]): Opener {
  if (privateKeysBase64.length === 0)
    throw new SecretsError("at least one secrets private key is required");
  const keys = new Map<string, { privateKey: KeyObject; publicRaw: Buffer }>();
  for (const value of privateKeysBase64) {
    const privateRaw = decodeKey(value, "a secrets private key");
    const privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, privateRaw]),
      format: "der",
      type: "pkcs8",
    });
    const publicRaw = rawPublic(createPublicKey(privateKey));
    keys.set(keyId(publicRaw).toString("hex"), { privateKey, publicRaw });
  }
  return {
    open(sealed, context) {
      const buffer = Buffer.from(sealed);
      if (buffer.length < HEADER_BYTES + TAG_BYTES || buffer[0] !== VERSION) {
        throw new SecretsError("not a sealed secret");
      }
      const id = buffer.subarray(1, 1 + KEY_ID_BYTES).toString("hex");
      const entry = keys.get(id);
      if (!entry) throw new SecretsError("sealed to a key this process does not hold");
      const ephemeralRaw = buffer.subarray(1 + KEY_ID_BYTES, 1 + KEY_ID_BYTES + PUBLIC_BYTES);
      const nonce = buffer.subarray(1 + KEY_ID_BYTES + PUBLIC_BYTES, HEADER_BYTES);
      const body = buffer.subarray(HEADER_BYTES, buffer.length - TAG_BYTES);
      const tag = buffer.subarray(buffer.length - TAG_BYTES);
      try {
        const ephemeral = createPublicKey({
          key: Buffer.concat([SPKI_PREFIX, ephemeralRaw]),
          format: "der",
          type: "spki",
        });
        const shared = diffieHellman({ privateKey: entry.privateKey, publicKey: ephemeral });
        const decipher = createDecipheriv(
          "aes-256-gcm",
          deriveKey(shared, ephemeralRaw, entry.publicRaw),
          nonce,
        );
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        // One message for every failure: the cause (wrong context, tampering) is not for the caller to learn.
        throw new SecretsError(
          "could not open the secret: wrong key, wrong owner, or altered bytes",
        );
      }
    },
  };
}

/** `a,b` -> ["a", "b"]: how config carries more than one private key during rotation. */
export const splitKeys = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
