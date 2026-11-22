// The control plane's schema, shared by the services that read it: control (operators), api (key
// verification), worker (tenant lookup, usage). Services never import each other, so the schema and
// its queries live here (ADR 0006).
import { join } from "node:path";

/** Control-plane migrations, for `migrate(controlDb, [controlMigrationsDir])`. */
export const controlMigrationsDir = join(import.meta.dirname, "..", "migrations", "control");

export { APP_ROLE, restrictControlDatabase, setAppRolePassword } from "./app-role.ts";
export { type AuditDetail, audit } from "./audit.ts";
export {
  type ApiKeyRecord,
  type Authenticated,
  authenticateApiKey,
  type CreatedKey,
  createApiKey,
  listApiKeys,
  parseApiKey,
  revokeApiKey,
} from "./keys.ts";
export {
  deleteModelKey,
  hasModelKey,
  isProviderId,
  listModelKeys,
  MAX_MODEL_KEYS_PER_TENANT,
  ModelKeyLimitError,
  putModelKey,
  readModelKey,
} from "./secrets.ts";
export {
  deleteTenantRow,
  getTenant,
  insertTenant,
  listTenants,
  type NewTenant,
  setSchemaVersion,
  setTenantStatus,
  TenantNameTakenError,
  type TenantRecord,
  type TenantStatus,
  tenantDatabaseNames,
  tenantDbPassword,
  tenantDbUrl,
} from "./tenants.ts";
export { recordUsage, type UsageEntry } from "./usage.ts";
