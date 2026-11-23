// The `webhook` destination (ADR 0019): one signed POST per event, by Standard Webhooks v1
// (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md), so a receiver verifies
// with any Standard Webhooks library. Every request goes through the egress guard (ADR 0010): only public addresses,
// redirects refused. Errors name the host at most: a URL's path or query may hold the tenant's token.
import { createHmac, randomBytes } from "node:crypto";
import type { DeliveryOutcome, Destination } from "@kerby/delivery";
import { EgressError, type EgressFetch } from "@kerby/egress";

/** Bytes of the endpoint's answer kept for the delivery log; the rest is never read. */
const RESPONSE_EXCERPT_BYTES = 1024;
const SECRET_PREFIX = "whsec_";

type WebhookOptions = {
  /** The egress guard's fetch (`createEgressFetch`), with the deadline of one delivery. */
  fetch: EgressFetch;
  /** Development only: plain http URLs (pair it with an egress fetch that allows private addresses). */
  allowLocal: boolean;
  /** Milliseconds since the epoch; tests pin it to a published signature. */
  now?: () => number;
};

/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">` under one `whsec_` secret. */
function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(
    secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret,
    "base64",
  );
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The first KiB of a response as text (null when empty), then the body is cancelled: a huge answer costs nothing. */
async function excerpt(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < RESPONSE_EXCERPT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // An answer cut off or too slow still has its status; what arrived is kept.
  } finally {
    void reader.cancel().catch(() => {});
  }
  const text = new TextDecoder()
    .decode(Buffer.concat(chunks).subarray(0, RESPONSE_EXCERPT_BYTES))
    .trimEnd();
  return text === "" ? null : text;
}

/** Why a request got no answer, for the tenant's delivery log: the guard's reason and host, never the URL. */
function describe(error: unknown, signal: AbortSignal): string {
  if (error instanceof EgressError) return `${error.reason}: ${error.message}`;
  if (signal.aborted) return "the delivery was cancelled";
  return "the request failed";
}

export function createWebhookDestination(options: WebhookOptions): Destination<"webhook"> {
  const now = options.now ?? Date.now;
  return {
    kind: "webhook",
    maxBatch: 1,
    newSecret: () => `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`,
    check(config) {
      if (new URL(config.url).protocol !== "https:" && !options.allowLocal)
        return "the webhook URL must use https";
      return undefined;
    },
    async deliver({ config, secrets, events, signal }): Promise<DeliveryOutcome> {
      const [event] = events;
      if (!event || events.length > 1)
        throw new Error(`a webhook delivers one event at a time, not ${events.length}`);
      if (secrets.length === 0) throw new Error("a webhook needs a signing secret");
      const timestamp = Math.floor(now() / 1000).toString();
      let response: Response;
      try {
        response = await options.fetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Kerby-Webhooks/1",
            "webhook-id": event.id,
            "webhook-timestamp": timestamp,
            "webhook-signature": secrets
              .map((secret) => sign(secret, event.id, timestamp, event.body))
              .join(" "),
          },
          body: event.body,
          redirect: "error",
          signal,
        });
      } catch (error) {
        return { type: "failed", error: describe(error, signal), status: null, response: null };
      }
      const status = response.status;
      const answer = { status, response: await excerpt(response) };
      if (status >= 200 && status < 300) return { type: "delivered", ...answer };
      if (status === 410) return { type: "gone", error: "HTTP 410 Gone", ...answer };
      return { type: "failed", error: `HTTP ${status}`, ...answer };
    },
  };
}
