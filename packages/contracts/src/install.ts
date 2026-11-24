// The install's own shapes (ADR 0024): the one tenant's name, its limits, and the console admin's email. Kerby's
// services share them; they are not part of the tenant-facing API (`tenant.ts`).
import { z } from "zod";

/**
 * Per-tenant limits, kept in the tenant's row. An absent key takes the deployment default (the worker's or the api's
 * config).
 */
export const LimitsSchema = z.object({
  /** Turns running at once for this tenant (default: the worker's `DEFAULT_MAX_CONCURRENT_TURNS`, 4). */
  maxConcurrentTurns: z.number().int().positive().optional(),
  /**
   * Authenticated requests per minute, per api process (default `DEFAULT_REQUESTS_PER_MINUTE`, 600): a token bucket
   * that bursts up to a minute's worth. Approximate: with N api processes a tenant gets up to N times this.
   */
  requestsPerMinute: z.number().int().positive().optional(),
  /**
   * Bytes of stored objects (the tenant's blob index), checked when a message is posted (default
   * `DEFAULT_STORAGE_BYTES`, 1 GiB). A turn already admitted finishes even if its answer goes over.
   */
  storageBytes: z.number().int().positive().optional(),
  /** Event subscriptions the tenant may hold (default the api's `DEFAULT_SUBSCRIPTIONS`, 10; ADR 0019). */
  subscriptions: z.number().int().nonnegative().optional(),
  /** Deliveries in flight at once for this tenant (default the dispatcher's `DEFAULT_CONCURRENT_DELIVERIES`, 4). */
  concurrentDeliveries: z.number().int().positive().optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

/** A tenant's name (`KERBY_TENANT_NAME`): it also names the install in the console. */
export const TenantNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes");

/** An email as the console keeps it: trimmed and lower-cased, so one address is one account. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email("an email address like you@example.com"));
