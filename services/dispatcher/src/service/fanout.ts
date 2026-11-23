// Fan-out (ADR 0019): move each subscription's cursor through the tenant's event log and turn the events it selects into
// `deliver-events` tasks, in one tenant transaction per page. The cursor row is locked for the page, so two dispatchers
// fanning out the same subscription take turns; the task's idempotency key (`deliver:<subscription>:<first event>`)
// makes a page spawned twice one task anyway.
import { expandEventTypes, type Visibility } from "@kerby/contracts";
import {
  type DeliverableSubscription,
  listDeletedSubscriptions,
  listDeliverableSubscriptions,
  purgeSubscription,
} from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import { cancelTasks, DELIVERY_RETRY, spawnInTx } from "@kerby/durable";
import { dropCursor, type EventFilter, lockCursor, readEvents, saveCursor } from "@kerby/events";
import { log } from "@kerby/observability";
import type { DispatcherDeps } from "../types/index.ts";

/** Events read per transaction. */
const PAGE_SIZE = 100;
/** Pages per subscription per pump: a deep backlog yields to the claim and to other subscriptions, and resumes next pump. */
const MAX_PAGES = 10;

/** `tenant` scope sees every event only while its integration still holds the `tenant` scope; otherwise its own. */
function visibilityOf(subscription: DeliverableSubscription): Visibility {
  return subscription.scope === "tenant" && subscription.integrationScopes.includes("tenant")
    ? "tenant"
    : { integrationId: subscription.integrationId };
}

/** Fan out one subscription; returns the events it queued for delivery. */
async function fanOutSubscription(
  deps: DispatcherDeps,
  ctx: TenantContext,
  subscription: DeliverableSubscription,
): Promise<number> {
  const { maxBatch } = deps.destinations[subscription.destination.kind];
  const filter: EventFilter = {
    visibility: visibilityOf(subscription),
    types: expandEventTypes(subscription.types),
  };
  let queued = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const read = await ctx.db.transaction(async (tx) => {
      const cursor = await lockCursor(tx, subscription.id);
      const { events, next } = await readEvents(tx, cursor, filter, PAGE_SIZE);
      for (let start = 0; start < events.length; start += maxBatch) {
        const eventIds = events.slice(start, start + maxBatch).map((event) => event.id);
        await spawnInTx(
          tx,
          "deliver-events",
          { subscriptionId: subscription.id, eventIds },
          { idempotencyKey: `deliver:${subscription.id}:${eventIds[0]}`, ...DELIVERY_RETRY },
        );
      }
      await saveCursor(tx, subscription.id, next);
      return events.length;
    });
    queued += read;
    if (read < PAGE_SIZE) break;
  }
  return queued;
}

/**
 * Finish deleting subscriptions (their tombstones): cancel their queued deliveries and drop their cursors in the
 * tenant's database, which the console, deleting an integration, cannot reach; then remove the tombstone.
 */
async function cleanUpDeleted(deps: DispatcherDeps, ctx: TenantContext): Promise<void> {
  for (const id of await listDeletedSubscriptions(deps.control, ctx.tenantId)) {
    const cancelled = await ctx.db.transaction(async (tx) => {
      const count = await cancelTasks(tx, "deliver-events", "subscriptionId", id);
      await dropCursor(tx, id);
      return count;
    });
    await purgeSubscription(deps.control, id);
    log("info", "deleted subscription cleaned up", { subscriptionId: id, cancelled });
  }
}

/** Fan out every deliverable subscription of the tenant, after cleaning up deleted ones; returns the events queued. */
export async function fanOut(deps: DispatcherDeps, ctx: TenantContext): Promise<number> {
  await cleanUpDeleted(deps, ctx);
  let queued = 0;
  for (const subscription of await listDeliverableSubscriptions(deps.control, ctx.tenantId)) {
    queued += await fanOutSubscription(deps, ctx, subscription);
  }
  return queued;
}
