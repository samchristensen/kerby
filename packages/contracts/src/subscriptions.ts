// Event subscriptions (ADR 0019): where an integration's events are pushed. Managed with the `admin` scope or in the
// console; `/v1/subscriptions`.
import { z } from "zod";
import { EventTypePatternSchema } from "./events.ts";

/** A URL that receives signed POSTs (Standard Webhooks). https outside development. */
const WebhookDestinationSchema = z.object({
  kind: z.literal("webhook"),
  url: z
    .url({ protocol: /^https?$/, error: "an http(s) URL" })
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    }, "no user or password in the URL: put a token in the path or query"),
});

/** Every destination kind (ADR 0019): a new kind is one more member here, an adapter package and a registry line. */
export const DestinationConfigSchema = z.discriminatedUnion("kind", [WebhookDestinationSchema]);
export type DestinationConfig = z.infer<typeof DestinationConfigSchema>;

/** `own`: what the subscription's integration started. `tenant`: everything (needs its `tenant` scope). */
export const SubscriptionScopeSchema = z.enum(["own", "tenant"]);
export type SubscriptionScope = z.infer<typeof SubscriptionScopeSchema>;

const TypesSchema = z.array(EventTypePatternSchema).min(1).max(20);
const DescriptionSchema = z.string().trim().max(200);

export const CreateSubscriptionRequestSchema = z.object({
  /** The integration it belongs to; default the calling key's. A console session must name one. */
  integrationId: z.uuid().optional(),
  destination: DestinationConfigSchema,
  types: TypesSchema,
  scope: SubscriptionScopeSchema.default("own"),
  description: DescriptionSchema.default(""),
});
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

/** Change what is given. `enabled: true` re-enables a disabled subscription, which resumes where it stopped. */
export const UpdateSubscriptionRequestSchema = z
  .object({
    destination: DestinationConfigSchema.optional(),
    types: TypesSchema.optional(),
    scope: SubscriptionScopeSchema.optional(),
    description: DescriptionSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "nothing to change",
  });
export type UpdateSubscriptionRequest = z.infer<typeof UpdateSubscriptionRequestSchema>;

export const SubscriptionSchema = z.object({
  id: z.uuid(),
  integrationId: z.uuid(),
  destination: DestinationConfigSchema,
  types: z.array(EventTypePatternSchema),
  scope: SubscriptionScopeSchema,
  description: z.string(),
  state: z.enum(["active", "disabled"]),
  /** Why it was disabled: by hand, a 410 from the endpoint, or 48 hours of failures. */
  disabledReason: z.string().nullable(),
  /** Since when every delivery has failed; null while healthy. */
  failingSince: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** The signing secret is returned here and on rotation, never again. */
const CreateSubscriptionResponseSchema = z.object({
  subscription: SubscriptionSchema,
  secret: z.string(),
});
export type CreateSubscriptionResponse = z.infer<typeof CreateSubscriptionResponseSchema>;

const ListSubscriptionsResponseSchema = z.object({ subscriptions: z.array(SubscriptionSchema) });
export type ListSubscriptionsResponse = z.infer<typeof ListSubscriptionsResponseSchema>;

/** The old secret keeps signing, beside the new one, until `previousExpiresAt`. */
const RotateSecretResponseSchema = z.object({
  secret: z.string(),
  previousExpiresAt: z.iso.datetime(),
});
export type RotateSecretResponse = z.infer<typeof RotateSecretResponseSchema>;

export const DeliveryAttemptSchema = z.object({
  id: z.string(),
  eventIds: z.array(z.uuid()),
  attempt: z.number().int().positive(),
  /** `failed` is retried while `willRetry`; `gone` (410) disabled the subscription. */
  outcome: z.enum(["delivered", "failed", "gone"]),
  willRetry: z.boolean(),
  /** The endpoint's HTTP status, when it answered. */
  status: z.number().int().nullable(),
  error: z.string().nullable(),
  /** The start of the endpoint's answer, at most 1 KiB. */
  response: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  at: z.iso.datetime(),
});
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;

/** `GET /v1/subscriptions/:id/deliveries?limit=<n>&before=<id>`: newest first. */
export const ListDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
});
export type ListDeliveriesQuery = z.infer<typeof ListDeliveriesQuerySchema>;

const ListDeliveriesResponseSchema = z.object({
  deliveries: z.array(DeliveryAttemptSchema),
  /** Pass as `before` for older attempts; null on the last page. */
  nextBefore: z.string().nullable(),
});
export type ListDeliveriesResponse = z.infer<typeof ListDeliveriesResponseSchema>;

/** Send one event from the log to this subscription again, whether or not it matched it. */
export const RedeliverRequestSchema = z.object({ eventId: z.uuid() });

/** A queued delivery: a test ping, or a redelivery. The delivery log shows how it went. */
const DeliveryQueuedResponseSchema = z.object({ eventId: z.uuid() });
export type DeliveryQueuedResponse = z.infer<typeof DeliveryQueuedResponseSchema>;
