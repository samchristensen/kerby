import type { AgentRuntime } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";

export type WorkerDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  /** The agent harness behind the port: only `src/index.ts` knows which one. */
  runtime: AgentRuntime;
  /**
   * A tenant's own model key for a provider, opened (bring your own key). Undefined only for the development fake
   * model, which needs no key; every real run requires one.
   */
  modelKeys: ((tenantId: string, provider: string) => Promise<string | undefined>) | undefined;
  settings: {
    workerId: string;
    claimTimeoutSeconds: number;
    /** Lease heartbeat period; default a third of the lease. Tests lengthen it to let a lease lapse. */
    heartbeatEveryMs?: number | undefined;
    /** Used for a tenant whose limits do not set `maxConcurrentTurns`. */
    defaultMaxConcurrentTurns: number;
    sweepIntervalMs: number;
    enableEchoTool: boolean;
    /** Bytes of message bodies a turn starts with; older whole turns past it are left out (`readHistory`). */
    historyBudgetBytes: number;
  };
};
