import type { ControlDb, TenantPools } from "@kerby/db";
import type { Destinations } from "@kerby/delivery";
import type { Opener } from "@kerby/secrets";

export type DispatcherDeps = {
  control: ControlDb;
  pools: TenantPools;
  /** Opens subscriptions' signing secrets (DELIVERY_SECRETS_PRIVATE_KEYS): only this service holds it. */
  opener: Opener;
  /** One adapter per destination kind, behind the port: only `src/index.ts` knows which. */
  destinations: Destinations;
  settings: {
    workerId: string;
    claimTimeoutSeconds: number;
    /** Lease heartbeat period; default a third of the lease. */
    heartbeatEveryMs?: number | undefined;
    /** Used for a tenant whose limits do not set `concurrentDeliveries`. */
    defaultConcurrentDeliveries: number;
    /** Deliveries this dispatcher runs at once across every tenant (`MAX_RUNNING_DELIVERIES`); bounds its tenant pools. */
    maxRunningDeliveries: number;
    sweepIntervalMs: number;
  };
};
