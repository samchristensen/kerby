// Console passwords are hashed here and nowhere else (the console checks them, control sets the configured admin's):
// scrypt (Node's crypto, no dependency) with OWASP's parameters, a random salt per password, and the parameters stored
// in the hash so a later cost change still verifies old hashes. The hash format is
// `scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, base64.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** log2 of scrypt's N for new hashes: 17 (128 MiB, about 0.2 s here) per OWASP. Tests pass a lower one. */
export const PASSWORD_COST = 17;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
/** A stored hash may not demand more than this (2^20 is 1 GiB): verifying must not be a way to exhaust memory. */
const MAX_COST = 20;
const STORED = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const derived = Promise.withResolvers<Buffer>();
  // scrypt needs 128 * N * r bytes; Node refuses anything over `maxmem`, so allow exactly that and a little more.
  const maxmem = 128 * 2 ** cost * r + 1024 * 1024;
  scrypt(password, salt, KEY_BYTES, { N: 2 ** cost, r, p, maxmem }, (error, key) =>
    error ? derived.reject(error) : derived.resolve(key),
  );
  return derived.promise;
}

export async function hashPassword(password: string, cost = PASSWORD_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, cost, R, P);
  return ["scrypt", cost, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/** Whether `password` matches `stored`. A hash this code would not make is a mismatch, never an exception. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = STORED.exec(stored);
  if (!match) return false;
  // The pattern guarantees every group; `?? ""` only satisfies the index type.
  const [cost, r, p] = [match[1], match[2], match[3]].map((group) => Number(group ?? ""));
  if (!cost || !r || !p || cost > MAX_COST) return false;
  const expected = Buffer.from(match[5] ?? "", "base64");
  const actual = await derive(password, Buffer.from(match[4] ?? "", "base64"), cost, r, p);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
