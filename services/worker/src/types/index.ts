import type { AgentRuntime } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";
import type { JudgmentProvider } from "@kerby/judgment";

export type WorkerDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  /** The agent harness behind the port: only `src/index.ts` knows which one. */
  runtime: AgentRuntime;
  /** The judgment providers behind the port (ADR 0015), by the provider id in a model id: only `src/index.ts` knows which. */
  judgments: readonly JudgmentProvider[];
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
    /** Turns this worker runs at once across every tenant (`MAX_RUNNING_TURNS`); bounds its tenant pools. */
    maxRunningTurns: number;
    /** Look at the tenants whose work is due (`SWEEP_INTERVAL_SECONDS`). */
    sweepIntervalMs: number;
    /** Look at every active tenant, the backstop for a lost hint (`FULL_SWEEP_INTERVAL_SECONDS`). */
    fullSweepIntervalMs: number;
    enableEchoTool: boolean;
    /** Bytes of message bodies a turn starts with; older whole turns past it are left out (`readHistory`). */
    historyBudgetBytes: number;
  };
};
