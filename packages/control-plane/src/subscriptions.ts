// Event subscriptions (ADR 0019): where an integration's events are pushed. The api makes and changes them (sealing the
// signing secret to the dispatcher's public key, which it cannot open); the dispatcher reads them, opens the secret
// inside a delivery, and records whether deliveries succeed. Cursors and the delivery log live in the tenant database.
import {
  type DestinationConfig,
  DestinationConfigSchema,
  type EventTypePattern,
  EventTypePatternSchema,
  type Scope,
  type SubscriptionScope,
  SubscriptionScopeSchema,
} from "@kerby/contracts";
import { type ControlQueryable, isUuid } from "@kerby/db";
import { type Opener, type Sealer, secretContext } from "@kerby/secrets";
import { integrationFromRow } from "./integrations.ts";

export type SubscriptionRecord = {
  id: string;
  tenantId: string;
  integrationId: string;
  destination: DestinationConfig;
  types: EventTypePattern[];
  scope: SubscriptionScope;
  description: string;
  state: "active" | "disabled";
  disabledReason: string | null;
  failingSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SubscriptionRow = {
  id: string;
  tenant_id: string;
  integration_id: string;
  destination: unknown;
  types: string[];
  scope: string;
  description: string;
  state: "active" | "disabled";
  disabled_reason: string | null;
  failing_since: Date | null;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS =
  "id, tenant_id, integration_id, destination, types, scope, description, state, disabled_reason, failing_since, created_at, updated_at";

/** Parsed on every read: a row the contracts no longer accept fails loudly. */
function fromRow(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    integrationId: row.integration_id,
    destination: DestinationConfigSchema.parse(row.destination),
    types: row.types.map((type) => EventTypePatternSchema.parse(type)),
    scope: SubscriptionScopeSchema.parse(row.scope),
    description: row.description,
    state: row.state,
    disabledReason: row.disabled_reason,
    failingSince: row.failing_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Binds a sealed secret to its tenant and subscription: one opened under another's id fails. */
const contextOf = (tenantId: string, subscriptionId: string): string =>
  secretContext(tenantId, `subscription/${subscriptionId}`);

export class SubscriptionLimitError extends Error {
  override name = "SubscriptionLimitError";
}

export type NewSubscription = {
  /** Chosen by the caller (`randomUUID`): the sealed secret is bound to it. */
  id: string;
  tenantId: string;
  integrationId: string;
  destination: DestinationConfig;
  types: readonly EventTypePattern[];
  scope: SubscriptionScope;
  description: string;
  /** The signing secret in the clear, sealed here; the caller shows it once. */
  secret: string;
};

/** Insert a subscription, unless the tenant already holds `limit`. Throws `SubscriptionLimitError` then. */
export async function insertSubscription(
  db: ControlQueryable,
  sealer: Sealer,
  input: NewSubscription,
  limit: number,
): Promise<SubscriptionRecord> {
  const { rows } = await db.query<SubscriptionRow>(
    `insert into subscriptions (id, tenant_id, integration_id, destination, types, scope, description, secret)
     select $1, $2, $3, $4::jsonb, $5, $6, $7, $8
      where (select count(*) from subscriptions where tenant_id = $2::uuid and state <> 'deleted') < $9
     returning ${COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.integrationId,
      JSON.stringify(input.destination),
      input.types,
      input.scope,
      input.description,
      sealer.seal(input.secret, contextOf(input.tenantId, input.id)),
      limit,
    ],
  );
  const row = rows[0];
  if (!row) throw new SubscriptionLimitError(`a tenant may hold at most ${limit} subscriptions`);
  return fromRow(row);
}

/** The tenant's subscriptions, oldest first. */
export async function listSubscriptions(
  db: ControlQueryable,
  tenantId: string,
): Promise<SubscriptionRecord[]> {
  if (!isUuid(tenantId)) return [];
  const { rows } = await db.query<SubscriptionRow>(
    `select ${COLUMNS} from subscriptions
      where tenant_id = $1 and state <> 'deleted' order by created_at, id`,
    [tenantId],
  );
  return rows.map(fromRow);
}

/** One of the tenant's subscriptions, or undefined (another tenant's id is simply not found). */
export async function getSubscription(
  db: ControlQueryable,
  tenantId: string,
  id: string,
): Promise<SubscriptionRecord | undefined> {
  if (!isUuid(id) || !isUuid(tenantId)) return undefined;
  const { rows } = await db.query<SubscriptionRow>(
    `select ${COLUMNS} from subscriptions where id = $1 and tenant_id = $2 and state <> 'deleted'`,
    [id, tenantId],
  );
  return rows[0] ? fromRow(rows[0]) : undefined;
}

export type SubscriptionChange = {
  destination?: DestinationConfig | undefined;
  types?: readonly EventTypePattern[] | undefined;
  scope?: SubscriptionScope | undefined;
  description?: string | undefined;
  /** true re-enables (clearing why it stopped and its failure streak); false disables by hand. */
  enabled?: boolean | undefined;
};

/** Change what is given; undefined when the tenant has no such subscription. */
export async function updateSubscription(
  db: ControlQueryable,
  tenantId: string,
  id: string,
  change: SubscriptionChange,
): Promise<SubscriptionRecord | undefined> {
  if (!isUuid(id) || !isUuid(tenantId)) return undefined;
  const { rows } = await db.query<SubscriptionRow>(
    `update subscriptions set
        destination = coalesce($3::jsonb, destination),
        types = coalesce($4, types),
        scope = coalesce($5, scope),
        description = coalesce($6, description),
        state = case when $7::boolean is null then state when $7 then 'active' else 'disabled' end,
        disabled_reason = case when $7::boolean is null then disabled_reason when $7 then null else 'disabled by hand' end,
        failing_since = case when $7::boolean then null else failing_since end,
        updated_at = now()
      where id = $1 and tenant_id = $2 and state <> 'deleted'
      returning ${COLUMNS}`,
    [
      id,
      tenantId,
      change.destination === undefined ? null : JSON.stringify(change.destination),
      change.types ?? null,
      change.scope ?? null,
      change.description ?? null,
      change.enabled ?? null,
    ],
  );
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/**
 * Delete a subscription: it leaves a tombstone (`state = 'deleted'`) that no read returns, until a dispatcher has
 * cancelled its queued deliveries and dropped its cursor in the tenant's database, then purges it. Returns whether one
 * was deleted.
 */
export async function deleteSubscription(
  db: ControlQueryable,
  tenantId: string,
  id: string,
): Promise<boolean> {
  if (!isUuid(id) || !isUuid(tenantId)) return false;
  const { rowCount } = await db.query(
    `update subscriptions set state = 'deleted', updated_at = now()
      where id = $1 and tenant_id = $2 and state <> 'deleted'`,
    [id, tenantId],
  );
  return rowCount === 1;
}

/**
 * Give a subscription a new secret; the old one keeps signing beside it for `overlapMs`. Undefined when the tenant has
 * no such subscription.
 */
export async function rotateSubscriptionSecret(
  db: ControlQueryable,
  sealer: Sealer,
  tenantId: string,
  id: string,
  secret: string,
  overlapMs: number,
): Promise<{ previousExpiresAt: Date } | undefined> {
  if (!isUuid(id) || !isUuid(tenantId)) return undefined;
  const { rows } = await db.query<{ previous_secret_expires_at: Date }>(
    `update subscriptions set
        previous_secret = secret,
        previous_secret_expires_at = now() + make_interval(secs => $4::double precision / 1000),
        secret = $3,
        updated_at = now()
      where id = $1 and tenant_id = $2 and state <> 'deleted'
      returning previous_secret_expires_at`,
    [id, tenantId, sealer.seal(secret, contextOf(tenantId, id)), overlapMs],
  );
  const row = rows[0];
  return row ? { previousExpiresAt: row.previous_secret_expires_at } : undefined;
}

// The dispatcher's side.

/** A subscription as the dispatcher fans out to it: with its integration's current scopes. */
export type DeliverableSubscription = SubscriptionRecord & { integrationScopes: Scope[] };

/** The tenant's active subscriptions of live integrations: what fan-out serves. */
export async function listDeliverableSubscriptions(
  db: ControlQueryable,
  tenantId: string,
): Promise<DeliverableSubscription[]> {
  if (!isUuid(tenantId)) return [];
  const { rows } = await db.query<
    SubscriptionRow & {
      integration_name: string;
      integration_scopes: string[];
      integration_created_at: Date;
    }
  >(
    `select ${COLUMNS.split(", ")
      .map((c) => `s.${c}`)
      .join(", ")}, i.name as integration_name, i.scopes as integration_scopes,
            i.created_at as integration_created_at
       from subscriptions s join integrations i on i.id = s.integration_id
      where s.tenant_id = $1 and s.state = 'active' and i.deleted_at is null
      order by s.created_at, s.id`,
    [tenantId],
  );
  return rows.map((row) => ({
    ...fromRow(row),
    integrationScopes: integrationFromRow({
      id: row.integration_id,
      tenant_id: row.tenant_id,
      name: row.integration_name,
      scopes: row.integration_scopes,
      created_at: row.integration_created_at,
    }).scopes,
  }));
}

/**
 * A subscription to deliver to, with its secrets opened (current first, then the previous one while it is valid), or
 * undefined when it is gone, disabled, or its integration was deleted: then its queued deliveries are dropped.
 */
export async function openSubscriptionForDelivery(
  db: ControlQueryable,
  opener: Opener,
  tenantId: string,
  id: string,
): Promise<{ subscription: SubscriptionRecord; secrets: string[] } | undefined> {
  if (!isUuid(id) || !isUuid(tenantId)) return undefined;
  const { rows } = await db.query<
    SubscriptionRow & { secret: Buffer; previous_secret: Buffer | null; previous_valid: boolean }
  >(
    `select ${COLUMNS.split(", ")
      .map((c) => `s.${c}`)
      .join(", ")}, s.secret, s.previous_secret,
            coalesce(s.previous_secret_expires_at > now(), false) as previous_valid
       from subscriptions s join integrations i on i.id = s.integration_id
      where s.id = $1 and s.tenant_id = $2 and s.state = 'active' and i.deleted_at is null`,
    [id, tenantId],
  );
  const row = rows[0];
  if (!row) return undefined;
  const context = contextOf(tenantId, id);
  const secrets = [opener.open(row.secret, context)];
  if (row.previous_secret && row.previous_valid)
    secrets.push(opener.open(row.previous_secret, context));
  return { subscription: fromRow(row), secrets };
}

/** A delivery succeeded: the subscription is healthy again. */
export async function recordDeliverySuccess(db: ControlQueryable, id: string): Promise<void> {
  await db.query(
    "update subscriptions set failing_since = null where id = $1 and failing_since is not null",
    [id],
  );
}

/**
 * A delivery failed: start or continue the failure streak, and disable the subscription once the streak is older than
 * `disableAfterMs`. Returns whether this disabled it.
 */
export async function recordDeliveryFailure(
  db: ControlQueryable,
  id: string,
  disableAfterMs: number,
): Promise<boolean> {
  const { rows } = await db.query<{ disabled: boolean }>(
    `update subscriptions set
        failing_since = coalesce(failing_since, now()),
        state = case when failing_since < now() - make_interval(secs => $2::double precision / 1000)
                     then 'disabled' else state end,
        disabled_reason = case when failing_since < now() - make_interval(secs => $2::double precision / 1000)
                     then $3 else disabled_reason end,
        updated_at = now()
      where id = $1 and state = 'active'
      returning state = 'disabled' as disabled`,
    [
      id,
      disableAfterMs,
      `every delivery failed for ${Math.round(disableAfterMs / 3_600_000)} hours`,
    ],
  );
  return rows[0]?.disabled ?? false;
}

/** Disable a subscription for `reason` (the endpoint answered 410 Gone). */
export async function disableSubscription(
  db: ControlQueryable,
  id: string,
  reason: string,
): Promise<void> {
  await db.query(
    `update subscriptions set state = 'disabled', disabled_reason = $2, updated_at = now()
      where id = $1 and state = 'active'`,
    [id, reason],
  );
}

/** The tenant's deleted subscriptions whose tenant-side state is not cleaned up yet. */
export async function listDeletedSubscriptions(
  db: ControlQueryable,
  tenantId: string,
): Promise<string[]> {
  if (!isUuid(tenantId)) return [];
  const { rows } = await db.query<{ id: string }>(
    "select id from subscriptions where tenant_id = $1 and state = 'deleted'",
    [tenantId],
  );
  return rows.map((row) => row.id);
}

/** Remove a deleted subscription's tombstone, once its queued deliveries and cursor are gone. */
export async function purgeSubscription(db: ControlQueryable, id: string): Promise<void> {
  await db.query("delete from subscriptions where id = $1 and state = 'deleted'", [id]);
}

/** Does the tenant hold any subscription, a deleted one awaiting cleanup included? Else a dispatcher skips it. */
export async function hasSubscriptions(db: ControlQueryable, tenantId: string): Promise<boolean> {
  if (!isUuid(tenantId)) return false;
  const { rows } = await db.query<{ found: boolean }>(
    "select exists (select 1 from subscriptions where tenant_id = $1) as found",
    [tenantId],
  );
  return rows[0]?.found ?? false;
}

/** Active tenants holding at least one subscription: whom the dispatcher sweeps. */
export async function listTenantsWithSubscriptions(db: ControlQueryable): Promise<string[]> {
  const { rows } = await db.query<{ tenant_id: string }>(
    `select distinct s.tenant_id from subscriptions s join tenants t on t.id = s.tenant_id
      where t.status = 'active'`,
  );
  return rows.map((row) => row.tenant_id);
}
