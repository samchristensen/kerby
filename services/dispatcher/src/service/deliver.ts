// One `deliver-events` task: open the subscription (a deleted or disabled one drops the task), send its events through
// the destination, and record the attempt in the tenant's delivery log. A failure throws, so Absurd retries it on the
// DELIVERY_RETRY schedule; 48 hours of failures, or a 410, disables the subscription. Kerby's logs carry ids, counts
// and the outcome, never a URL, a body or a secret: those belong to the tenant.
import { PingEventSchema } from "@kerby/contracts";
import {
  disableSubscription,
  openSubscriptionForDelivery,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import type { WireEvent } from "@kerby/delivery";
import type { RunContext, TaskParams } from "@kerby/durable";
import { findEvents, recordDeliveryAttempt } from "@kerby/events";
import { log } from "@kerby/observability";
import type { DispatcherDeps } from "../types/index.ts";

/** A subscription failing this long without one success is disabled (ADR 0019). */
const DISABLE_AFTER_MS = 48 * 60 * 60 * 1000;

class DeliveryFailedError extends Error {
  override name = "DeliveryFailedError";
}

export async function deliverEvents(
  deps: DispatcherDeps,
  ctx: TenantContext,
  params: TaskParams["deliver-events"],
  run: RunContext,
): Promise<void> {
  const { subscriptionId } = params;
  const opened = await openSubscriptionForDelivery(
    deps.control,
    deps.opener,
    ctx.tenantId,
    subscriptionId,
  );
  if (!opened) {
    log("info", "delivery dropped: the subscription is gone or disabled", { subscriptionId });
    return;
  }
  const { subscription, secrets } = opened;

  let events: WireEvent[];
  if ("ping" in params) {
    // A test ping is in no log: its body is made here, in the shape of every event.
    const ping = PingEventSchema.parse({
      id: params.ping.id,
      v: 1,
      type: "ping",
      createdAt: params.ping.createdAt,
      integrationId: subscription.integrationId,
      data: {},
    });
    events = [{ id: ping.id, body: JSON.stringify(ping) }];
  } else {
    // "tenant": fan-out already chose the events this subscription may see; a redelivery was checked by the api.
    const found = await findEvents(ctx.db, params.eventIds, "tenant");
    if (found.length === 0) {
      log("info", "delivery dropped: its events are no longer in the log", { subscriptionId });
      return;
    }
    events = found.map((event) => ({ id: event.id, body: JSON.stringify(event) }));
  }

  const started = performance.now();
  const outcome = await deps.destinations[subscription.destination.kind].deliver({
    config: subscription.destination,
    secrets,
    events,
    signal: run.signal,
  });
  const durationMs = Math.round(performance.now() - started);

  // A failure may end the subscription's 48-hour window, which decides whether this attempt is retried: ask first.
  const disabled =
    outcome.type === "failed" &&
    (await recordDeliveryFailure(deps.control, subscriptionId, DISABLE_AFTER_MS));
  const willRetry =
    outcome.type === "failed" &&
    !disabled &&
    (run.maxAttempts === null || run.attempt < run.maxAttempts);
  await recordDeliveryAttempt(ctx.db, {
    subscriptionId,
    eventIds: events.map((event) => event.id),
    attempt: run.attempt,
    outcome: outcome.type,
    willRetry,
    status: outcome.status,
    error: outcome.type === "delivered" ? null : outcome.error,
    response: outcome.response,
    durationMs,
  });
  // After the attempt is in the log, so a tenant who sees the subscription disabled also sees why.
  if (outcome.type === "delivered") await recordDeliverySuccess(deps.control, subscriptionId);
  else if (outcome.type === "gone")
    await disableSubscription(deps.control, subscriptionId, "the endpoint answered 410 Gone");
  log(outcome.type === "delivered" ? "info" : "warn", "delivery attempted", {
    subscriptionId,
    events: events.length,
    attempt: run.attempt,
    outcome: outcome.type,
    status: outcome.status,
    durationMs,
    willRetry,
    disabled: disabled || outcome.type === "gone",
  });
  // Absurd retries a task that throws, and fails it for good after the last attempt. The error names the status or the
  // guard's reason and host, never the URL. A disabled subscription is not retried: its task ends here.
  if (outcome.type === "failed" && !disabled)
    throw new DeliveryFailedError(`delivery failed: ${outcome.error}`);
}
