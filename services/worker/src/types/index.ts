import type { AgentRuntime } from "@kerby/agent";
import type { Blobs } from "@kerby/blobs";
import type { ControlDb, TenantPools } from "@kerby/db";
import type { EgressFetch } from "@kerby/egress";
import type { JudgmentProvider } from "@kerby/judgment";

/** Tool servers' sealed credentials (ADR 0019), opened inside the step that uses them. */
export type ToolCredentials = {
  read(tenantId: string, serverId: string): Promise<string | undefined>;
  /**
   * Replace a credential under a lock on its row (an OAuth connection's refreshed tokens): `change` gets the value as
   * stored now and returns its replacement, `undefined` to keep it, or `null` to delete it. Nothing happens when none
   * is stored.
   */
  update(
    tenantId: string,
    serverId: string,
    change: (current: string) => Promise<string | null | undefined>,
  ): Promise<string | undefined>;
};

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
  /** Tool servers' credentials; undefined without the secrets private key. */
  toolCredentials: ToolCredentials | undefined;
  /** The only `fetch` that reaches a tenant's MCP server: the egress guard's. */
  toolFetch: EgressFetch;
  settings: {
    workerId: string;
    claimTimeoutSeconds: number;
    /** Lease heartbeat period; default a third of the lease. Tests lengthen it to let a lease lapse. */
    heartbeatEveryMs?: number | undefined;
    /** Used for a tenant whose limits do not set `maxConcurrentTurns`. */
    defaultMaxConcurrentTurns: number;
    /** Turns this worker runs at once across every tenant (`MAX_RUNNING_TURNS`); bounds its tenant pools. */
    maxRunningTurns: number;
    sweepIntervalMs: number;
    /** Offer the built-in `kerby/echo` to conversations that name it (development). */
    enableEchoTool: boolean;
    /** One call to a tenant's MCP tool, at most; past it the model reads an error result. */
    toolCallTimeoutMs: number;
    /** Bytes of message bodies a turn starts with; older whole turns past it are left out (`readHistory`). */
    historyBudgetBytes: number;
  };
};
