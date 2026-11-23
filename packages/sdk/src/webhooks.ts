// Verifying the webhooks Kerby POSTs to a subscription's URL (Standard Webhooks v1, ADR 0019):
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
// Web Crypto only, so it runs on Node, Bun, Deno and edge runtimes alike.
import { PingEventSchema, type PublicEvent, PublicEventSchema } from "@kerby/contracts/tenant";
import type { z } from "zod";
import { KerbyError } from "./errors.ts";

/** An event as Kerby delivers it: a log event, or the `ping` that a subscription test sends. */
export type WebhookEvent = PublicEvent | z.infer<typeof PingEventSchema>;

export type WebhookFailure =
  /** `webhook-id`, `webhook-timestamp` or `webhook-signature` is absent. */
  | "missing_headers"
  /** `webhook-timestamp` is not whole seconds since the epoch. */
  | "bad_timestamp"
  /** The timestamp is further from now than `toleranceSeconds`: a replay, or a clock that is off. */
  | "timestamp_out_of_tolerance"
  /** No `v1` signature in the header matches the body under any of the secrets. */
  | "bad_signature"
  /** The signature is right but the body is not an event this SDK knows (an SDK older than the API). */
  | "bad_payload";

/** A request that is not a genuine, fresh webhook from Kerby. Answer it with a 4xx and do not process it. */
export class WebhookVerificationError extends KerbyError {
  override name = "WebhookVerificationError";
  readonly reason: WebhookFailure;

  constructor(reason: WebhookFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1,";
const DEFAULT_TOLERANCE_SECONDS = 300;

/** The bytes of a standard base64 string, or undefined when it is not one. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export type VerifyWebhookOptions = {
  /**
   * The subscription's signing secret (`whsec_...`), as `subscriptions.create` or `rotateSecret` returned it. Pass
   * both the new and the old secret during a rotation: the request verifies when any secret matches.
   */
  secret: string | readonly string[];
  /** The request body exactly as received, before any JSON parsing: re-serializing it changes the bytes that were signed. */
  body: string;
  /** The request's headers: a `Headers`, or a plain object such as Node's `IncomingMessage.headers`. */
  headers: Headers | Readonly<Record<string, string | string[] | undefined>>;
  /** How far `webhook-timestamp` may be from now, either way. Default 300. */
  toleranceSeconds?: number;
  /** Milliseconds since the epoch. Default `Date.now`; tests pin it. */
  now?: () => number;
};

/**
 * Check that a request is a genuine, fresh webhook from Kerby and return its event.
 *
 * Throws `WebhookVerificationError` (see `reason`) on any failure; answer those with a 4xx. Throws `TypeError` when a
 * `secret` is not a `whsec_` + base64 string: that is a mistake in your configuration, not in the request.
 */
export async function verifyWebhook(options: VerifyWebhookOptions): Promise<WebhookEvent> {
  const header = (name: string): string | undefined => {
    const { headers } = options;
    const value =
      headers instanceof Headers
        ? headers.get(name)
        : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    return (Array.isArray(value) ? value.join(" ") : value) || undefined;
  };
  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signatures = header("webhook-signature");
  if (id === undefined || timestamp === undefined || signatures === undefined)
    throw new WebhookVerificationError(
      "missing_headers",
      "the webhook-id, webhook-timestamp and webhook-signature headers are all required",
    );

  if (!/^\d{1,15}$/.test(timestamp))
    throw new WebhookVerificationError(
      "bad_timestamp",
      "webhook-timestamp is not whole seconds since the epoch",
    );
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = (options.now ?? Date.now)() / 1000;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance)
    throw new WebhookVerificationError(
      "timestamp_out_of_tolerance",
      `webhook-timestamp is more than ${tolerance} seconds from now`,
    );

  const secrets = typeof options.secret === "string" ? [options.secret] : options.secret;
  if (secrets.length === 0) throw new TypeError("Kerby: verifyWebhook needs at least one secret");
  const { subtle } = globalThis.crypto;
  const keys = await Promise.all(
    secrets.map((secret) => {
      const bytes = fromBase64(
        secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret,
      );
      if (!bytes || bytes.length === 0)
        throw new TypeError("Kerby: a webhook secret must be `whsec_` followed by base64");
      return subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    }),
  );

  // A `webhook-signature` holds one `v1,<base64>` per live secret, space separated; other versions are not ours.
  const candidates = signatures
    .split(/\s+/)
    .filter((token) => token.startsWith(SIGNATURE_VERSION))
    .flatMap((token) => fromBase64(token.slice(SIGNATURE_VERSION.length)) ?? []);
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${options.body}`);
  // `subtle.verify` compares in constant time. Every pair is checked, so how long this takes says nothing about which matched.
  const matches = await Promise.all(
    keys.flatMap((key) =>
      candidates.map((signature) => subtle.verify("HMAC", key, signature, signed)),
    ),
  );
  if (!matches.includes(true))
    throw new WebhookVerificationError("bad_signature", "no webhook-signature matches the body");

  let payload: unknown;
  try {
    payload = JSON.parse(options.body);
  } catch {
    throw new WebhookVerificationError("bad_payload", "the signed body is not JSON");
  }
  const event = PublicEventSchema.safeParse(payload);
  if (event.success) return event.data;
  const ping = PingEventSchema.safeParse(payload);
  if (ping.success) return ping.data;
  throw new WebhookVerificationError(
    "bad_payload",
    "the signed body is not an event this SDK knows; update the SDK",
  );
}
