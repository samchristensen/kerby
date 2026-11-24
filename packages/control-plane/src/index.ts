// The control plane's schema, shared by the services that read it: control (operators), api (key
// verification), worker (tenant lookup, usage). Services never import each other, so the schema and
// its queries live here (ADR 0006).
import { join } from "node:path";

/** Control-plane migrations, for `migrate(controlDb, [controlMigrationsDir])`. */
export const controlMigrationsDir = join(import.meta.dirname, "..", "migrations", "control");

export { audit } from "./audit.ts";
export {
  authenticateConsoleSession,
  createConsoleSession,
  deleteConsoleSession,
  deleteOtherConsoleUsers,
  EmailTakenError,
  findConsoleUser,
  insertConsoleUser,
  readConsoleSession,
  setConsoleUserPassword,
} from "./console.ts";
export {
  listTenantsWithoutDbPassword,
  newTenantDbPassword,
  readTenantDbPassword,
  resealTenantDbPasswords,
  resolveTenantDbUrl,
  storeTenantDbPassword,
} from "./db-credentials.ts";
export {
  createIntegration,
  deleteIntegration,
  ensureDefaultIntegration,
  getIntegration,
  IntegrationNameTakenError,
  type IntegrationRecord,
  listIntegrations,
  setIntegrationScopes,
} from "./integrations.ts";
export {
  ApiKeyLimitError,
  type ApiKeyRecord,
  authenticateApiKey,
  type CreatedKey,
  createApiKey,
  ensureConfiguredApiKey,
  listApiKeys,
  MAX_API_KEYS_PER_TENANT,
  newApiKey,
  parseApiKey,
  revokeApiKey,
} from "./keys.ts";
export { hashPassword, PASSWORD_COST, verifyPassword } from "./passwords.ts";
export { restrictControlDatabase, setRolePassword } from "./roles.ts";
export {
  deleteModelKey,
  hasModelKey,
  listModelKeys,
  MAX_MODEL_KEYS_PER_TENANT,
  ModelKeyLimitError,
  putModelKey,
  readModelKey,
} from "./secrets.ts";
export {
  type DeliverableSubscription,
  deleteSubscription,
  disableSubscription,
  getSubscription,
  hasSubscriptions,
  insertSubscription,
  listDeletedSubscriptions,
  listDeliverableSubscriptions,
  listSubscriptions,
  listTenantsWithSubscriptions,
  openSubscriptionForDelivery,
  purgeSubscription,
  recordDeliveryFailure,
  recordDeliverySuccess,
  rotateSubscriptionSecret,
  SubscriptionLimitError,
  type SubscriptionRecord,
  updateSubscription,
} from "./subscriptions.ts";
export {
  deleteTenantRow,
  getTenant,
  insertTenant,
  listTenants,
  setSchemaVersion,
  setTenantStatus,
  TenantNameTakenError,
  type TenantRecord,
} from "./tenants.ts";
export {
  deleteToolCredential,
  hasToolCredential,
  putToolCredential,
  readToolCredential,
  updateToolCredential,
} from "./tool-credentials.ts";
export { recordUsage } from "./usage.ts";
export {
  hintTenantWork,
  listDueTenants,
  readWakeupVersion,
  settleTenantWakeup,
} from "./wakeups.ts";
