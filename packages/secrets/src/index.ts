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

// A secret box: secrets the process that stores them must also open, such as tenant database passwords (ADR 0009).
// AES-256-GCM under a list of symmetric keys: the first seals, every key opens, so a key is retired by putting a new
// one first and re-sealing. The `context` is authenticated as in `seal`. Layout: version(1) | key id(8) | nonce(12) |
// ciphertext | tag(16). The version differs from the sealed layout's, so one is never mistaken for the other.
const BOX_VERSION = 2;
const BOX_HEADER_BYTES = 1 + KEY_ID_BYTES + NONCE_BYTES;
const BOX_KEY_BYTES = 32;

export type SecretBox = {
  seal(plaintext: string, context: string): Buffer;
  open(sealed: Uint8Array, context: string): string;
  /** Sealed with the first key? Re-seal what is not before dropping an older key. */
  sealedWithCurrentKey(sealed: Uint8Array): boolean;
};

/** A new secret box key: 32 random bytes, base64. */
export const generateBoxKey = (): string => randomBytes(BOX_KEY_BYTES).toString("base64");

// The id names a key without revealing it: a hash of 32 random bytes, domain-separated from the sealed key ids.
const boxKeyId = (key: Buffer): string =>
  createHash("sha256")
    .update("kerby-secret-box-key-id:")
    .update(key)
    .digest()
    .subarray(0, KEY_ID_BYTES)
    .toString("hex");

/**
 * A box over `keysBase64` (each 32 bytes, base64): seals with the first, opens with any. `name` is how config calls one
 * key, for the error message.
 */
export function createSecretBox(keysBase64: readonly string[], name = "secret box key"): SecretBox {
  const fix = `each ${name} must be 32 bytes, base64 encoded (generate one: make secrets-key)`;
  const keys = new Map<string, Buffer>();
  for (const value of keysBase64) {
    const key = Buffer.from(value.trim(), "base64");
    if (key.length !== BOX_KEY_BYTES) throw new SecretsError(fix);
    keys.set(boxKeyId(key), key);
  }
  const [currentId, currentKey] = keys.entries().next().value ?? [];
  if (currentId === undefined || currentKey === undefined) {
    throw new SecretsError(`at least one ${name} is required: ${fix}`);
  }
  const currentIdBytes = Buffer.from(currentId, "hex");
  const idOf = (buffer: Buffer): string | undefined =>
    buffer.length >= BOX_HEADER_BYTES + TAG_BYTES && buffer[0] === BOX_VERSION
      ? buffer.subarray(1, 1 + KEY_ID_BYTES).toString("hex")
      : undefined;
  return {
    seal(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", currentKey, nonce);
      cipher.setAAD(Buffer.from(context));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([
        Buffer.of(BOX_VERSION),
        currentIdBytes,
        nonce,
        body,
        cipher.getAuthTag(),
      ]);
    },
    open(sealed, context) {
      const buffer = Buffer.from(sealed);
      const id = idOf(buffer);
      if (id === undefined) throw new SecretsError("not a secret box ciphertext");
      const key = keys.get(id);
      if (!key) throw new SecretsError(`sealed with a ${name} this process does not hold`);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          buffer.subarray(1 + KEY_ID_BYTES, BOX_HEADER_BYTES),
        );
        decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(buffer.subarray(buffer.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(buffer.subarray(BOX_HEADER_BYTES, buffer.length - TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new SecretsError("could not open the secret: wrong owner or altered bytes");
      }
    },
    sealedWithCurrentKey(sealed) {
      return idOf(Buffer.from(sealed)) === currentId;
    },
  };
}

// One install (ADR 0024) generates one secret, `KERBY_SECRET_KEY`, and derives every other key from it: HKDF-SHA256 with
// one `info` label per use, so no derived key reveals another or the master. Any 32 bytes are a valid X25519 private
// key, so the key pairs derive directly. Changing a label changes that key: the sealed secrets and role passwords made
// with the old one stop opening.
const INSTANCE_SALT = Buffer.from("kerby-instance-v1");

/** Every key and password an install uses, derived from its `KERBY_SECRET_KEY`. All base64 but the passwords. */
export type InstanceKeys = {
  /** Seals tenant database passwords: `TENANT_DB_KEYS`. */
  tenantDbKey: string;
  /** Tenants' model keys and tool credentials (ADR 0008): `SECRETS_PRIVATE_KEYS`, `SECRETS_PUBLIC_KEY`. */
  secrets: { privateKey: string; publicKey: string };
  /** Subscriptions' signing secrets (ADR 0019): `DELIVERY_SECRETS_PRIVATE_KEYS`, `DELIVERY_SECRETS_PUBLIC_KEY`. */
  delivery: { privateKey: string; publicKey: string };
  /** The `kerby_app` role's password on the control database (api, worker, dispatcher); base64url, URL-safe. */
  appDatabasePassword: string;
  /** The `kerby_console` role's password on the control database; base64url, URL-safe. */
  consoleDatabasePassword: string;
};

/** Derive an install's keys from `KERBY_SECRET_KEY` (32 bytes, base64). The same master always gives the same keys. */
export function deriveInstanceKeys(masterBase64: string): InstanceKeys {
  const master = Buffer.from(masterBase64.trim(), "base64");
  if (master.length !== 32) {
    throw new SecretsError(
      "KERBY_SECRET_KEY must be 32 bytes, base64 encoded (generate one: make secrets-key)",
    );
  }
  const derive = (label: string) =>
    Buffer.from(hkdfSync("sha256", master, INSTANCE_SALT, `kerby/${label}`, 32));
  const pair = (label: string) => {
    const privateKey = derive(label).toString("base64");
    return { privateKey, publicKey: publicKeyOf(privateKey) };
  };
  return {
    tenantDbKey: derive("tenant-db").toString("base64"),
    secrets: pair("secrets"),
    delivery: pair("delivery"),
    appDatabasePassword: derive("role/kerby_app").toString("base64url"),
    consoleDatabasePassword: derive("role/kerby_console").toString("base64url"),
  };
}

/** A new `KERBY_SECRET_KEY`: 32 random bytes, base64. */
export const generateInstanceSecret = (): string => randomBytes(32).toString("base64");
