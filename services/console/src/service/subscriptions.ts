// Event subscriptions (ADR 0019), managed from an integration's page. They live behind the api's `/v1/subscriptions`,
// which the console calls with the person's session token, like a chat: the api seals the signing secret to the
// dispatcher's key pair, checks the destination, enforces the tenant's limit and audits each change.
import {
  CreateSubscriptionRequestSchema,
  type CreateSubscriptionResponse,
  DeliveryAttemptSchema,
  type DeliveryQueuedResponse,
  EVENT_TYPES,
  type ListDeliveriesResponse,
  type ListSubscriptionsResponse,
  type RotateSecretResponse,
  type Subscription,
  SubscriptionSchema,
  SubscriptionScopeSchema,
  UpdateSubscriptionRequestSchema,
} from "@kerby/contracts";
import { z } from "zod";
import type {
  ChatAccess,
  ConsoleDeps,
  ConsoleService,
  EventTypeOption,
  FormFailure,
  FormInput,
} from "../types/index.ts";
import { apiError, apiFault } from "./api.ts";
import { parseForm, refuse } from "./forms.ts";

/** Form field `type.<pattern>` is the checkbox of an event type, a family wildcard (`turn.*`) or `*`. */
const TYPE_FIELD_PREFIX = "type.";

const option = (pattern: string): EventTypeOption => ({
  pattern,
  field: `${TYPE_FIELD_PREFIX}${pattern}`,
});

/** Event types by family (`turn`: `turn.started`, ...), in catalog order: the form's groups and their wildcards. */
const EVENT_FAMILIES = [
  ...new Set(EVENT_TYPES.map((type) => type.slice(0, type.indexOf(".")))),
].map((family) => ({
  family,
  wildcard: option(`${family}.*`),
  types: EVENT_TYPES.filter((type) => type.startsWith(`${family}.`)).map(option),
}));
const EVERY_TYPE = option("*");

const DELIVERIES_PER_PAGE = 25;

const ListSchema: z.ZodType<ListSubscriptionsResponse> = z.object({
  subscriptions: z.array(SubscriptionSchema),
});
const CreatedSchema: z.ZodType<CreateSubscriptionResponse> = z.object({
  subscription: SubscriptionSchema,
  secret: z.string(),
});
const RotatedSchema: z.ZodType<RotateSecretResponse> = z.object({
  secret: z.string(),
  previousExpiresAt: z.iso.datetime(),
});
const QueuedSchema: z.ZodType<DeliveryQueuedResponse> = z.object({ eventId: z.uuid() });
const DeliveriesSchema: z.ZodType<ListDeliveriesResponse> = z.object({
  deliveries: z.array(DeliveryAttemptSchema),
  nextBefore: z.string().nullable(),
});

const CreateForm = z.object({
  url: z.string().trim().min(1, "enter the URL that receives the events"),
  description: z.string().trim().max(200, "at most 200 characters").default(""),
  scope: SubscriptionScopeSchema.catch("own"),
});

/**
 * The patterns ticked in a form, as few as say the same: `*` alone, else a family's wildcard instead of its types.
 * Undefined when none is ticked.
 */
function checkedTypes(form: FormInput): string[] | undefined {
  const checked = ({ field }: { field: string }) => {
    const value = form[field];
    return typeof value === "string" && value !== "";
  };
  if (checked(EVERY_TYPE)) return [EVERY_TYPE.pattern];
  const patterns = EVENT_FAMILIES.flatMap(({ wildcard, types }) =>
    (checked(wildcard) ? [wildcard] : types.filter(checked)).map(({ pattern }) => pattern),
  );
  return patterns.length > 0 ? patterns : undefined;
}

/** A subscription id goes into a path: only a uuid is let through. */
const isId = (id: string) => z.uuid().safeParse(id).success;

const GONE = refuse("This subscription no longer exists. Reload the page.");

/**
 * What the person is told when the api refuses a subscription request. A fault on our side (5xx, a bad credential, a
 * request this code should never have made) is thrown instead.
 */
async function refusal(response: Response): Promise<FormFailure> {
  const { code, message } = await apiError(response);
  switch (code) {
    case "invalid_destination":
      return { ok: false, fields: { url: message ?? "This URL cannot receive events." } };
    case "forbidden":
      return { ok: false, fields: { scope: message ?? "The integration lacks this scope." } };
    case "not_found":
      return GONE;
    case "rate_limited":
      return refuse("Too many requests. Try again in a moment.");
    case "subscription_limit":
    case "invalid_request":
      return refuse(message ?? "The request was refused.");
  }
  throw apiFault("subscription", response.status, code);
}

/** Every subscription of the tenant: a console session sees them all. */
export async function listAllSubscriptions(
  deps: ConsoleDeps,
  access: ChatAccess,
): Promise<Subscription[]> {
  const response = await deps.api({
    method: "GET",
    path: "/v1/subscriptions",
    token: access.token,
  });
  if (!response.ok) throw new Error(`the api refused a subscription list: ${response.status}`);
  return ListSchema.parse(await response.json()).subscriptions;
}

type Subscriptions = Pick<
  ConsoleService,
  | "eventTypeOptions"
  | "subscriptions"
  | "subscription"
  | "createSubscription"
  | "setSubscriptionEnabled"
  | "deleteSubscription"
  | "rotateSubscriptionSecret"
  | "testSubscription"
  | "deliveries"
>;

export function createSubscriptions(deps: ConsoleDeps): Subscriptions {
  const { api } = deps;

  return {
    eventTypeOptions() {
      return { all: EVERY_TYPE, families: EVENT_FAMILIES };
    },

    async subscriptions(access, integrationId) {
      return (await listAllSubscriptions(deps, access)).filter(
        (subscription) => subscription.integrationId === integrationId,
      );
    },

    async subscription(access, id) {
      if (!isId(id)) return undefined;
      const response = await api({
        method: "GET",
        path: `/v1/subscriptions/${id}`,
        token: access.token,
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`the api refused a subscription read: ${response.status}`);
      return SubscriptionSchema.parse(await response.json());
    },

    async createSubscription(access, integrationId, form) {
      if (!isId(integrationId)) return refuse("This integration no longer exists.");
      const parsed = parseForm(CreateForm, form);
      const types = checkedTypes(form);
      if (!parsed.ok || !types) {
        return {
          ok: false,
          fields: {
            ...(parsed.ok ? {} : parsed.fields),
            ...(types ? {} : { types: "Choose at least one event type." }),
          },
        };
      }
      const request = CreateSubscriptionRequestSchema.safeParse({
        integrationId,
        destination: { kind: "webhook", url: parsed.data.url },
        types,
        scope: parsed.data.scope,
        description: parsed.data.description,
      });
      if (!request.success) {
        // The only field a person can get wrong here that the form did not check is the URL.
        const issue = request.error.issues[0];
        const text = issue?.message ?? "an http(s) URL";
        return { ok: false, fields: { url: text.charAt(0).toUpperCase() + text.slice(1) } };
      }
      const response = await api({
        method: "POST",
        path: "/v1/subscriptions",
        token: access.token,
        body: request.data,
      });
      if (response.status === 404) return refuse("This integration no longer exists.");
      if (response.status !== 201) return refusal(response);
      return { ok: true, ...CreatedSchema.parse(await response.json()) };
    },

    async setSubscriptionEnabled(access, id, enabled) {
      if (!isId(id)) return GONE;
      const response = await api({
        method: "PATCH",
        path: `/v1/subscriptions/${id}`,
        token: access.token,
        body: UpdateSubscriptionRequestSchema.parse({ enabled }),
      });
      if (!response.ok) return refusal(response);
      return { ok: true };
    },

    async deleteSubscription(access, id) {
      if (!isId(id)) return GONE;
      const response = await api({
        method: "DELETE",
        path: `/v1/subscriptions/${id}`,
        token: access.token,
      });
      if (!response.ok) return refusal(response);
      return { ok: true };
    },

    async rotateSubscriptionSecret(access, id) {
      if (!isId(id)) return GONE;
      const response = await api({
        method: "POST",
        path: `/v1/subscriptions/${id}/secret`,
        token: access.token,
      });
      if (!response.ok) return refusal(response);
      return { ok: true, ...RotatedSchema.parse(await response.json()) };
    },

    async testSubscription(access, id) {
      if (!isId(id)) return GONE;
      const response = await api({
        method: "POST",
        path: `/v1/subscriptions/${id}/test`,
        token: access.token,
      });
      if (response.status !== 202) return refusal(response);
      return { ok: true, eventId: QueuedSchema.parse(await response.json()).eventId };
    },

    async deliveries(access, id, before) {
      if (!isId(id)) return undefined;
      const query = new URLSearchParams({ limit: String(DELIVERIES_PER_PAGE) });
      // A position typed into the address bar that the api would refuse reads the newest page instead.
      if (before && /^\d{1,19}$/.test(before)) query.set("before", before);
      const response = await api({
        method: "GET",
        path: `/v1/subscriptions/${id}/deliveries?${query}`,
        token: access.token,
      });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`the api refused a delivery log read: ${response.status}`);
      return DeliveriesSchema.parse(await response.json());
    },
  };
}
