import type { Bucket } from "@kerby/blobs";
import type { ClusterAdmin, ControlDb, TenantPools } from "@kerby/db";
import type { SecretBox } from "@kerby/secrets";

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
  /** Seals and opens tenant database passwords (TENANT_DB_KEYS, ADR 0009). */
  tenantDbBox: SecretBox;
  settings: {
    clusterHost: string;
    clusterPort: number;
    tenantDbSslmode?: "disable" | "require" | "verify-full" | undefined;
    templateDatabase: string;
    pgDumpPath: string;
    /** Console sign-ups started in any hour, across every control process (SIGNUP_BUDGET_PER_HOUR). */
    signupBudgetPerHour: number;
  };
};

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** The sign-up budget for the hour is spent; one place frees up in `retryAfterSeconds`. */
export class SignupsPausedError extends Error {
  override name = "SignupsPausedError";
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A request that conflicts with the state of things; `code` is the error code the response carries. */
export class ConflictError extends Error {
  override name = "ConflictError";
  readonly code: string;

  constructor(message: string, code = "conflict") {
    super(message);
    this.code = code;
  }
}
