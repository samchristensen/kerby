import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KerbyError } from "./errors.ts";
import { verifyWebhook, WebhookVerificationError } from "./webhooks.ts";

const NOW_SECONDS = 1_800_000_000;
const now = () => NOW_SECONDS * 1000;

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

/** What the sender (packages/delivery-webhook) puts in `webhook-signature`, made independently with node:crypto. */
const sign = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")}`;

const ID = "4b0cbd7e-8a0b-4d0f-9f5e-0e9a4a7c1d11";
const event = {
  id: ID,
  v: 1,
  type: "turn.completed",
  createdAt: "2026-11-23T10:00:00.000Z",
  integrationId: null,
  data: { conversationId: "0b6f0e3a-3f5c-4a53-9d63-0b5f3f4b7a10", seq: 1, lastSeq: 2 },
};
const body = JSON.stringify(event);

const signed = (secret: string, overrides: Record<string, string> = {}) => ({
  "webhook-id": ID,
  "webhook-timestamp": String(NOW_SECONDS),
  "webhook-signature": sign(secret, ID, NOW_SECONDS, body),
  ...overrides,
});

const failure = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return error as WebhookVerificationError;
};

describe("verifyWebhook", () => {
  it("accepts a signature made independently with node:crypto and returns the typed event", async () => {
    const secret = newSecret();
    const verified = await verifyWebhook({ secret, body, headers: signed(secret), now });
    expect(verified).toEqual(event);
  });

  it("accepts the Standard Webhooks reference vector (the signature checks out; the body is not an event)", async () => {
    const error = await failure(
      verifyWebhook({
        secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        body: '{"test": 2432232314}',
        headers: {
          "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
          "webhook-timestamp": "1614265330",
          "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
        },
        now: () => 1614265330 * 1000,
      }),
    );
    expect(error.reason).toBe("bad_payload");
  });

  it("returns a ping, and reads a Headers object and any header-name case", async () => {
    const secret = newSecret();
    const ping = { ...event, type: "ping", data: {} };
    const pingBody = JSON.stringify(ping);
    const headers = new Headers({
      "Webhook-Id": ID,
      "Webhook-Timestamp": String(NOW_SECONDS),
      "Webhook-Signature": sign(secret, ID, NOW_SECONDS, pingBody),
    });
    expect(await verifyWebhook({ secret, body: pingBody, headers, now })).toEqual(ping);
    const shouting = Object.fromEntries(
      [...headers].map(([key, value]) => [key.toUpperCase(), value]),
    );
    expect(await verifyWebhook({ secret, body: pingBody, headers: shouting, now })).toEqual(ping);
  });

  it("is a KerbyError that names the reason", async () => {
    const error = await failure(verifyWebhook({ secret: newSecret(), body, headers: {}, now }));
    expect(error).toBeInstanceOf(KerbyError);
    expect(error.reason).toBe("missing_headers");
  });

  it("rejects a tampered body", async () => {
    const secret = newSecret();
    const error = await failure(
      verifyWebhook({
        secret,
        body: body.replace('"seq":1', '"seq":9'),
        headers: signed(secret),
        now,
      }),
    );
    expect(error.reason).toBe("bad_signature");
  });

  it("rejects the wrong secret and a tampered id or timestamp", async () => {
    const secret = newSecret();
    const headers = signed(secret);
    expect((await failure(verifyWebhook({ secret: newSecret(), body, headers, now }))).reason).toBe(
      "bad_signature",
    );
    const otherId = { ...headers, "webhook-id": "someone-else" };
    expect((await failure(verifyWebhook({ secret, body, headers: otherId, now }))).reason).toBe(
      "bad_signature",
    );
    const later = { ...headers, "webhook-timestamp": String(NOW_SECONDS + 1) };
    expect((await failure(verifyWebhook({ secret, body, headers: later, now }))).reason).toBe(
      "bad_signature",
    );
  });

  it("rejects a timestamp too old or too far in the future, and honors the tolerance", async () => {
    const secret = newSecret();
    const at = (timestamp: number) => ({
      "webhook-id": ID,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(secret, ID, timestamp, body),
    });
    const stale = await failure(
      verifyWebhook({ secret, body, headers: at(NOW_SECONDS - 301), now }),
    );
    expect(stale.reason).toBe("timestamp_out_of_tolerance");
    const early = await failure(
      verifyWebhook({ secret, body, headers: at(NOW_SECONDS + 301), now }),
    );
    expect(early.reason).toBe("timestamp_out_of_tolerance");
    await verifyWebhook({ secret, body, headers: at(NOW_SECONDS - 300), now });
    await verifyWebhook({ secret, body, headers: at(NOW_SECONDS + 300), now });
    const tight = await failure(
      verifyWebhook({ secret, body, headers: at(NOW_SECONDS - 11), now, toleranceSeconds: 10 }),
    );
    expect(tight.reason).toBe("timestamp_out_of_tolerance");
    await verifyWebhook({
      secret,
      body,
      headers: at(NOW_SECONDS - 3600),
      now,
      toleranceSeconds: 7200,
    });
  });

  it("rejects missing headers, one at a time", async () => {
    const secret = newSecret();
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers: Record<string, string | undefined> = { ...signed(secret), [name]: undefined };
      expect((await failure(verifyWebhook({ secret, body, headers, now }))).reason).toBe(
        "missing_headers",
      );
    }
    const empty = { ...signed(secret), "webhook-signature": "" };
    expect((await failure(verifyWebhook({ secret, body, headers: empty, now }))).reason).toBe(
      "missing_headers",
    );
  });

  it("rejects a timestamp that is not whole seconds", async () => {
    const secret = newSecret();
    for (const timestamp of ["soon", "1.5", "-5", "", "1e9"]) {
      const headers = signed(secret, { "webhook-timestamp": timestamp });
      const error = await failure(verifyWebhook({ secret, body, headers, now }));
      expect(error.reason).toBe(timestamp === "" ? "missing_headers" : "bad_timestamp");
    }
  });

  it("verifies a rotation header holding two signatures under either secret", async () => {
    const fresh = newSecret();
    const old = newSecret();
    const headers = signed(fresh, {
      "webhook-signature": `${sign(fresh, ID, NOW_SECONDS, body)} ${sign(old, ID, NOW_SECONDS, body)}`,
    });
    expect(await verifyWebhook({ secret: fresh, body, headers, now })).toEqual(event);
    expect(await verifyWebhook({ secret: old, body, headers, now })).toEqual(event);
    const stranger = await failure(verifyWebhook({ secret: newSecret(), body, headers, now }));
    expect(stranger.reason).toBe("bad_signature");
  });

  it("accepts a list of secrets and matches any of them", async () => {
    const fresh = newSecret();
    const old = newSecret();
    const headers = signed(old);
    expect(await verifyWebhook({ secret: [fresh, old], body, headers, now })).toEqual(event);
    expect(await verifyWebhook({ secret: [old, fresh], body, headers, now })).toEqual(event);
    const none = await failure(verifyWebhook({ secret: [fresh, newSecret()], body, headers, now }));
    expect(none.reason).toBe("bad_signature");
  });

  it("reads a header array (a repeated webhook-signature) like the space separated form", async () => {
    const fresh = newSecret();
    const old = newSecret();
    const headers = {
      ...signed(fresh),
      "webhook-signature": [sign(old, ID, NOW_SECONDS, body), sign(fresh, ID, NOW_SECONDS, body)],
    };
    expect(await verifyWebhook({ secret: fresh, body, headers, now })).toEqual(event);
  });

  it("ignores signature versions other than v1 and garbage entries", async () => {
    const secret = newSecret();
    const good = sign(secret, ID, NOW_SECONDS, body);
    const headers = signed(secret, {
      "webhook-signature": `v2,${good.slice(3)} v1,not*base64 v1a,AAAA ${good}`,
    });
    expect(await verifyWebhook({ secret, body, headers, now })).toEqual(event);
    const onlyOther = signed(secret, { "webhook-signature": `v2,${good.slice(3)}` });
    const error = await failure(verifyWebhook({ secret, body, headers: onlyOther, now }));
    expect(error.reason).toBe("bad_signature");
  });

  it("rejects a signed body that is not JSON or not an event", async () => {
    const secret = newSecret();
    for (const unknown of ["not json", JSON.stringify({ ...event, type: "turn.exploded" })]) {
      const headers = {
        "webhook-id": ID,
        "webhook-timestamp": String(NOW_SECONDS),
        "webhook-signature": sign(secret, ID, NOW_SECONDS, unknown),
      };
      const error = await failure(verifyWebhook({ secret, body: unknown, headers, now }));
      expect(error.reason).toBe("bad_payload");
    }
  });

  it("takes the secret with or without its whsec_ prefix, and refuses a malformed one", async () => {
    const secret = newSecret();
    const headers = signed(secret);
    const bare = secret.slice("whsec_".length);
    expect(await verifyWebhook({ secret: bare, body, headers, now })).toEqual(event);
    await expect(verifyWebhook({ secret: "whsec_", body, headers, now })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(verifyWebhook({ secret: "whsec_%%%", body, headers, now })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(verifyWebhook({ secret: [], body, headers, now })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("uses the current time when none is given", async () => {
    const secret = newSecret();
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "webhook-id": ID,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(secret, ID, timestamp, body),
    };
    expect(await verifyWebhook({ secret, body, headers })).toEqual(event);
  });
});
