import type { Bucket } from "@kerby/blobs";
import type { ClusterAdmin, ControlDb, TenantPools } from "@kerby/db";
import type { SecretBox } from "@kerby/secrets";

/** Everything control's work needs, built once in `src/index.ts` and passed down. */
export type ControlDeps = {
  control: ControlDb;
  cluster: ClusterAdmin;
  /** The bucket holding every tenant's objects under `t/<tenantId>/`. */
  bucket: Bucket;
  /** Opens tenant databases as their own roles (used to migrate them). */
  pools: TenantPools;
  /** Seals and opens tenant database passwords (TENANT_DB_KEYS, ADR 0009). */
  tenantDbBox: SecretBox;
  settings: {
    clusterHost: string;
    clusterPort: number;
    tenantDbSslmode?: "disable" | "require" | "verify-full" | undefined;
    templateDatabase: string;
  };
};
