import type { AgentRuntime } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";

export type WorkerDeps = {
  control: ControlDb;
  pools: TenantPools;
  blobs: Blobs;
  /** The agent harness behind the port: only `src/index.ts` knows which one. */
  runtime: AgentRuntime;
  settings: {
    workerId: string;
    claimTimeoutSeconds: number;
    /** Lease heartbeat period; default a third of the lease. Tests lengthen it to let a lease lapse. */
    heartbeatEveryMs?: number | undefined;
    /** Used for a tenant whose limits do not set `maxConcurrentTurns`. */
    defaultMaxConcurrentTurns: number;
    sweepIntervalMs: number;
    enableEchoTool: boolean;
  };
};
