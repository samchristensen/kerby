import { hostname } from "node:os";
import { loadConfig } from "@kerby/config";
import { z } from "zod";

export const dispatcherConfigSchema = z.object({
  controlDatabaseUrl: z.string().min(1),
  /** Opens tenants' stored database passwords (ADR 0009): the launcher derives it from KERBY_SECRET_KEY. */
  tenantDbKeys: z.string().min(1),
  /** `sslmode` for tenant database URLs; omit for a Postgres on a private network or locally, which does not use TLS. */
  tenantDbSslmode: z.enum(["disable", "require", "verify-full"]).optional(),
  /**
   * Private key(s) that open subscriptions' sealed signing secrets (ADR 0019), base64, comma separated: the key new
   * secrets are sealed to first, older ones after it while a rotation finishes. Not the worker's key pair.
   */
  deliverySecretsPrivateKeys: z.string().min(1),
  /** Where alerts are posted: Slack, Discord or any JSON webhook (docs/deploy.md#alerts). Unset or empty: log lines only. */
  alertWebhookUrl: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  /** Set by Railway on every deployment; names the environment in alerts. */
  railwayEnvironmentName: z.string().min(1).optional(),
  /** Names this dispatcher in Absurd's run rows. */
  workerId: z
    .string()
    .min(1)
    .default(() => `${hostname()}:${process.pid}`),
  /**
   * Deliver to plain http and private addresses: the install's own application on its private network or this
   * machine (ADR 0010, amended by 0024). The api has the same setting.
   */
  allowLocalDestinations: z.stringbool().default(false),
  /** Port of the liveness endpoint (`GET /healthz`) for the container health check. */
  healthPort: z.coerce.number().int().min(0).default(8083),
  /** How often to look at every tenant with subscriptions for events a notification missed. */
  sweepIntervalSeconds: z.coerce.number().positive().default(5),
  /** Lease length; a heartbeat extends it for as long as a delivery runs (one POST is at most 10 s). */
  claimTimeoutSeconds: z.coerce.number().int().positive().default(60),
  /** Deliveries one tenant may run at once across dispatchers when its limits do not say. */
  defaultConcurrentDeliveries: z.coerce.number().int().positive().default(4),
  /**
   * Deliveries this dispatcher runs at once across all tenants. Each holds its tenant's pool of 2 connections, and at
   * most 20 pools stay open, so this bounds the dispatcher's tenant connections (docs/deploy.md#postgres).
   */
  maxRunningDeliveries: z.coerce.number().int().positive().default(20),
});

export type DispatcherConfig = z.output<typeof dispatcherConfigSchema>;

export const loadDispatcherConfig = (): DispatcherConfig => loadConfig(dispatcherConfigSchema);
