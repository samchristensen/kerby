// Event subscriptions (ADR 0019): where Kerby pushes an integration's events, as signed webhooks. Verify what arrives
// with `verifyWebhook` (../webhooks.ts).
import {
  type CreateSubscriptionRequestSchema,
  CreateSubscriptionResponseSchema,
  type DeliveryAttempt,
  DeliveryQueuedResponseSchema,
  ListDeliveriesResponseSchema,
  ListSubscriptionsResponseSchema,
  RotateSecretResponseSchema,
  SubscriptionSchema,
  type UpdateSubscriptionRequestSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { segment, type Transport } from "../http.ts";

type Options = { signal?: AbortSignal };
type Subscription = z.output<typeof SubscriptionSchema>;

export type CreateSubscriptionInput = z.input<typeof CreateSubscriptionRequestSchema>;
export type UpdateSubscriptionInput = z.input<typeof UpdateSubscriptionRequestSchema>;

export type ListDeliveriesOptions = Options & {
  /** Attempts per page, 1 to 100. Default 50. */
  limit?: number;
  /** A previous page's `nextBefore`: returns the attempts older than it. */
  before?: string;
};

export class Subscriptions {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * Create a subscription: `POST /v1/subscriptions`. Needs the `admin` scope.
   * The signing `secret` (`whsec_...`) is in this response only (and in `rotateSecret`'s): store it now, it cannot be
   * read again. The subscription receives events committed from now on.
   * Errors: `invalid_destination` (the URL is refused, e.g. plain http outside development), `subscription_limit`
   * (409), `forbidden` (`scope: "tenant"` for an integration without the `tenant` scope), `invalid_request`
   * (no `integrationId` when the key belongs to no integration).
   */
  create(input: CreateSubscriptionInput, options?: Options) {
    return this.#http.request({
      method: "POST",
      path: "/v1/subscriptions",
      body: input,
      signal: options?.signal,
      schema: CreateSubscriptionResponseSchema,
    });
  }

  /** List the subscriptions the caller may manage: `GET /v1/subscriptions`. Needs the `admin` scope. */
  async list(options?: Options): Promise<Subscription[]> {
    const { subscriptions } = await this.#http.request({
      method: "GET",
      path: "/v1/subscriptions",
      signal: options?.signal,
      schema: ListSubscriptionsResponseSchema,
    });
    return subscriptions;
  }

  /** Read one subscription: `GET /v1/subscriptions/:id`. Needs the `admin` scope. */
  get(id: string, options?: Options): Promise<Subscription> {
    return this.#http.request({
      method: "GET",
      path: `/v1/subscriptions/${segment(id)}`,
      signal: options?.signal,
      schema: SubscriptionSchema,
    });
  }

  /**
   * Change the given fields: `PATCH /v1/subscriptions/:id`. Needs the `admin` scope.
   * `enabled: true` re-enables a disabled subscription, which resumes where it stopped.
   * Errors: `invalid_destination`, `forbidden` (as in `create`), `invalid_request` when nothing is given.
   */
  update(id: string, changes: UpdateSubscriptionInput, options?: Options): Promise<Subscription> {
    return this.#http.request({
      method: "PATCH",
      path: `/v1/subscriptions/${segment(id)}`,
      body: changes,
      signal: options?.signal,
      schema: SubscriptionSchema,
    });
  }

  /** Delete a subscription and its delivery log: `DELETE /v1/subscriptions/:id`. Needs the `admin` scope. */
  delete(id: string, options?: Options): Promise<void> {
    return this.#http.send({
      method: "DELETE",
      path: `/v1/subscriptions/${segment(id)}`,
      signal: options?.signal,
    });
  }

  /**
   * Make a new signing secret: `POST /v1/subscriptions/:id/secret`. Needs the `admin` scope.
   * The new `secret` is in this response only. The old one keeps signing beside it until `previousExpiresAt`
   * (24 hours), so pass both to `verifyWebhook` until then.
   */
  rotateSecret(id: string, options?: Options) {
    return this.#http.request({
      method: "POST",
      path: `/v1/subscriptions/${segment(id)}/secret`,
      signal: options?.signal,
      schema: RotateSecretResponseSchema,
    });
  }

  /**
   * Queue a signed `ping` event (in no log) for the endpoint: `POST /v1/subscriptions/:id/test`. Needs the `admin`
   * scope. Answers 202 with the ping's id; how the delivery went shows in `listDeliveries`.
   */
  sendTestPing(id: string, options?: Options) {
    return this.#http.request({
      method: "POST",
      path: `/v1/subscriptions/${segment(id)}/test`,
      signal: options?.signal,
      schema: DeliveryQueuedResponseSchema,
    });
  }

  /**
   * Send an event from the log to this subscription again, whether or not it matched its types:
   * `POST /v1/subscriptions/:id/redeliver`. Needs the `admin` scope. Answers 202 once queued.
   * Errors: `not_found` for an event the caller or the subscription may not see, or that does not exist.
   */
  redeliver(id: string, eventId: string, options?: Options) {
    return this.#http.request({
      method: "POST",
      path: `/v1/subscriptions/${segment(id)}/redeliver`,
      body: { eventId },
      signal: options?.signal,
      schema: DeliveryQueuedResponseSchema,
    });
  }

  /**
   * One page of delivery attempts, newest first: `GET /v1/subscriptions/:id/deliveries`. Needs the `admin` scope.
   * `nextBefore` is null on the last page; otherwise pass it as `before` for the next. `listAllDeliveries` does that.
   */
  listDeliveries(id: string, options?: ListDeliveriesOptions) {
    return this.#http.request({
      method: "GET",
      path: `/v1/subscriptions/${segment(id)}/deliveries`,
      query: { limit: options?.limit, before: options?.before },
      signal: options?.signal,
      schema: ListDeliveriesResponseSchema,
    });
  }

  /** Every delivery attempt, newest first, page after page (same route and scope as `listDeliveries`). */
  async *listAllDeliveries(
    id: string,
    options?: Omit<ListDeliveriesOptions, "before">,
  ): AsyncGenerator<DeliveryAttempt, void, undefined> {
    let before: string | undefined;
    do {
      const page = await this.listDeliveries(id, {
        ...options,
        ...(before === undefined ? {} : { before }),
      });
      yield* page.deliveries;
      before = page.nextBefore ?? undefined;
    } while (before !== undefined);
  }
}
