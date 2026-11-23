// Event subscriptions (ADR 0019): where an integration's events are pushed, managed with the `admin` scope. The api
// makes the signing secret, seals it to the dispatcher's public key and shows it once; it never delivers anything
// itself, beyond queueing a test ping or a redelivery for the dispatcher.
import { randomUUID } from "node:crypto";
import type {
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  DeliveryQueuedResponse,
  DestinationConfig,
  ListDeliveriesQuery,
  ListDeliveriesResponse,
  ListSubscriptionsResponse,
  RotateSecretResponse,
  Subscription,
  UpdateSubscriptionRequest,
  Visibility,
} from "@kerby/contracts";
import {
  audit,
  deleteSubscription,
  getIntegration,
  getSubscription,
  type IntegrationRecord,
  insertSubscription,
  listSubscriptions,
  rotateSubscriptionSecret,
  type SubscriptionRecord,
  updateSubscription,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import type { Destinations } from "@kerby/delivery";
import { DELIVERY_RETRY, spawnInTx, type TaskParams } from "@kerby/durable";
import { findEvents, listDeliveryAttempts, lockCursor, notifyDispatchers } from "@kerby/events";
import { type ApiDeps, NotFoundError, type Principal } from "../types/index.ts";

/** After a rotation the old secret keeps signing beside the new one this long, so receivers can switch over. */
const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

/** The request did not say which integration: a console session acts for none. */
export class IntegrationRequiredError extends Error {
  override name = "IntegrationRequiredError";
}

/** The destination adapter will not deliver to this config; the message is for the tenant. */
export class InvalidDestinationError extends Error {
  override name = "InvalidDestinationError";
}

/** `scope: tenant` for an integration that does not hold the `tenant` scope. */
export class TenantScopeRequiredError extends Error {
  override name = "TenantScopeRequiredError";
}

function subscriptionResource(record: SubscriptionRecord): Subscription {
  return {
    id: record.id,
    integrationId: record.integrationId,
    destination: record.destination,
    types: record.types,
    scope: record.scope,
    description: record.description,
    state: record.state,
    disabledReason: record.disabledReason,
    failingSince: record.failingSince?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Why the kind's adapter refuses `config`, or undefined. One case per kind, so a new kind cannot skip its check. */
function destinationProblem(
  destinations: Destinations,
  config: DestinationConfig,
): string | undefined {
  switch (config.kind) {
    case "webhook":
      return destinations.webhook.check(config);
  }
}

function assertDestination(deps: ApiDeps, config: DestinationConfig): void {
  const problem = destinationProblem(deps.destinations, config);
  if (problem !== undefined) throw new InvalidDestinationError(problem);
}

/** Without the `tenant` scope a caller manages only its own integration's subscriptions (ADR 0020). */
const manages = (principal: Principal, integrationId: string): boolean =>
  principal.visibility === "tenant" || principal.visibility.integrationId === integrationId;

/** A live integration of the tenant the caller may manage; another's is not found, like one that does not exist. */
async function liveIntegration(
  deps: ApiDeps,
  principal: Principal,
  integrationId: string,
): Promise<IntegrationRecord> {
  const integration = await getIntegration(deps.control, principal.tenantId, integrationId);
  if (!integration || !manages(principal, integration.id))
    throw new NotFoundError("integration not found");
  return integration;
}

function assertScopeAllowed(integration: IntegrationRecord): void {
  if (!integration.scopes.includes("tenant"))
    throw new TenantScopeRequiredError(
      `integration "${integration.name}" lacks the tenant scope, so its subscriptions get only its own events (scope: own); grant the scope in the console`,
    );
}

async function found(deps: ApiDeps, principal: Principal, id: string): Promise<SubscriptionRecord> {
  const record = await getSubscription(deps.control, principal.tenantId, id);
  if (!record || !manages(principal, record.integrationId))
    throw new NotFoundError("subscription not found");
  return record;
}

const auditSubscription = (
  deps: ApiDeps,
  principal: Principal,
  action: string,
  record: Pick<SubscriptionRecord, "id" | "integrationId">,
) =>
  audit(deps.control, {
    tenantId: principal.tenantId,
    actor: principal.actor,
    action,
    detail: { subscriptionId: record.id, integrationId: record.integrationId },
  });

/**
 * Make a subscription for `integrationId` (default the caller's integration) that starts at "now": its cursor is made
 * at the log's horizon, so it gets events committed from here on. The secret is returned here and never again.
 */
export async function createTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  request: CreateSubscriptionRequest,
): Promise<CreateSubscriptionResponse> {
  const integrationId = request.integrationId ?? principal.integrationId;
  if (integrationId === null)
    throw new IntegrationRequiredError(
      "integrationId is required: a console session acts for no integration",
    );
  const integration = await liveIntegration(deps, principal, integrationId);
  if (request.scope === "tenant") assertScopeAllowed(integration);
  assertDestination(deps, request.destination);
  const secret = deps.destinations[request.destination.kind].newSecret();
  const record = await insertSubscription(
    deps.control,
    deps.deliverySealer,
    {
      id: randomUUID(),
      tenantId: principal.tenantId,
      integrationId: integration.id,
      destination: request.destination,
      types: request.types,
      scope: request.scope,
      description: request.description,
      secret,
    },
    principal.limits.subscriptions ?? deps.settings.defaultSubscriptions,
  );
  await ctx.db.transaction((tx) => lockCursor(tx, record.id));
  await auditSubscription(deps, principal, "subscription.create", record);
  return { subscription: subscriptionResource(record), secret };
}

export async function listTenantSubscriptions(
  deps: ApiDeps,
  principal: Principal,
): Promise<ListSubscriptionsResponse> {
  const records = (await listSubscriptions(deps.control, principal.tenantId)).filter((record) =>
    manages(principal, record.integrationId),
  );
  return { subscriptions: records.map(subscriptionResource) };
}

export async function getTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  id: string,
): Promise<Subscription> {
  return subscriptionResource(await found(deps, principal, id));
}

export async function updateTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  id: string,
  request: UpdateSubscriptionRequest,
): Promise<Subscription> {
  const existing = await found(deps, principal, id);
  if (request.scope === "tenant")
    assertScopeAllowed(await liveIntegration(deps, principal, existing.integrationId));
  if (request.destination) assertDestination(deps, request.destination);
  const record = await updateSubscription(deps.control, principal.tenantId, id, request);
  if (!record) throw new NotFoundError("subscription not found");
  await auditSubscription(deps, principal, "subscription.update", record);
  return subscriptionResource(record);
}

export async function deleteTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await found(deps, principal, id);
  if (!(await deleteSubscription(deps.control, principal.tenantId, id)))
    throw new NotFoundError("subscription not found");
  await auditSubscription(deps, principal, "subscription.delete", existing);
}

/** A new signing secret; the old one keeps signing beside it for a day. */
export async function rotateTenantSubscriptionSecret(
  deps: ApiDeps,
  principal: Principal,
  id: string,
): Promise<RotateSecretResponse> {
  const existing = await found(deps, principal, id);
  const secret = deps.destinations[existing.destination.kind].newSecret();
  const rotated = await rotateSubscriptionSecret(
    deps.control,
    deps.deliverySealer,
    principal.tenantId,
    id,
    secret,
    ROTATION_OVERLAP_MS,
  );
  if (!rotated) throw new NotFoundError("subscription not found");
  await auditSubscription(deps, principal, "subscription.rotate_secret", existing);
  return { secret, previousExpiresAt: rotated.previousExpiresAt.toISOString() };
}

/** Queue one delivery on the dispatchers' queue and tell them, after it commits. */
async function enqueueDelivery(
  deps: ApiDeps,
  ctx: TenantContext,
  params: TaskParams["deliver-events"],
  idempotencyKey: string,
): Promise<void> {
  await ctx.db.transaction((tx) =>
    spawnInTx(tx, "deliver-events", params, { idempotencyKey, ...DELIVERY_RETRY }),
  );
  await notifyDispatchers(deps.control, ctx.tenantId);
}

/** Send a `ping` that is in no log: proves the endpoint and its signature check, and shows in the delivery log. */
export async function pingTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  id: string,
): Promise<DeliveryQueuedResponse> {
  await found(deps, principal, id);
  const ping = { id: randomUUID(), createdAt: new Date().toISOString() };
  await enqueueDelivery(deps, ctx, { subscriptionId: id, ping }, `ping:${id}:${ping.id}`);
  return { eventId: ping.id };
}

/**
 * Send one event from the log to the subscription again, whether or not it matched its types. The event must be one
 * both the caller and the subscription may see: otherwise it is not found, like one that does not exist.
 */
export async function redeliverToTenantSubscription(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  id: string,
  eventId: string,
): Promise<DeliveryQueuedResponse> {
  const subscription = await found(deps, principal, id);
  const integration = await liveIntegration(deps, principal, subscription.integrationId);
  const sees: Visibility =
    subscription.scope === "tenant" && integration.scopes.includes("tenant")
      ? "tenant"
      : { integrationId: integration.id };
  const [event] = await findEvents(ctx.db, [eventId], principal.visibility);
  if (!event || (sees !== "tenant" && event.integrationId !== sees.integrationId))
    throw new NotFoundError("event not found");
  await enqueueDelivery(
    deps,
    ctx,
    { subscriptionId: id, eventIds: [event.id] },
    `redeliver:${id}:${event.id}:${randomUUID()}`,
  );
  return { eventId: event.id };
}

export async function listTenantDeliveries(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  id: string,
  page: ListDeliveriesQuery,
): Promise<ListDeliveriesResponse> {
  await found(deps, principal, id);
  return listDeliveryAttempts(ctx.db, id, page);
}
