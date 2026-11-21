import type { Blobs } from "@kerby/blobs";
import type { ClusterAdmin, ControlDb, TenantPools } from "@kerby/db";

/** Everything the operator commands need, built once in `src/index.ts` and passed down. */
export type ControlDeps = {
  control: ControlDb;
  cluster: ClusterAdmin;
  blobs: Blobs;
  /** Opens tenant databases as their own roles (used to migrate them). */
  pools: TenantPools;
  settings: {
    clusterHost: string;
    clusterPort: number;
    /** See `tenantDbPassword`. */
    tenantDbSecret: string;
    templateDatabase: string;
    exportDir: string;
    pgDumpPath: string;
  };
};

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export class ConflictError extends Error {
  override name = "ConflictError";
}
