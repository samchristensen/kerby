import type { Bucket } from "@kerby/blobs";
import type { ClusterAdmin, ControlDb, TenantPools } from "@kerby/db";

/** Everything the operator commands need, built once in `src/index.ts` and passed down. */
export type ControlDeps = {
  control: ControlDb;
  cluster: ClusterAdmin;
  buckets: {
    /** Every tenant's objects under `t/<tenantId>/`. */
    primary: Bucket;
    /** Tenant exports, `<tenantId>/<stamp>.dump` and `.objects.json`; only control holds its keys. */
    exports: Bucket;
    /** A copy of the primary's `t/`, in another region. */
    backup: Bucket;
  };
  /** The clock: exports are stamped and expire by it. Tests inject one. */
  now: () => Date;
  /** Opens tenant databases as their own roles (used to migrate them). */
  pools: TenantPools;
  settings: {
    clusterHost: string;
    clusterPort: number;
    /** See `tenantDbPassword`. */
    tenantDbSecret: string;
    tenantDbSslmode?: "disable" | "require" | "verify-full" | undefined;
    templateDatabase: string;
    pgDumpPath: string;
  };
};

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}
