// Tools (ADR 0019): the tenant tables of remote MCP servers, their tools, grants and conversations' tools, their repo,
// and Kerby's own tools.
import { join } from "node:path";

/** The tool tables' migrations; `tenantMigrationDirs` (packages/conversations) applies them last. */
export const toolsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

export { BUILTIN_TOOLS } from "./builtin.ts";
export {
  BuiltinToolServerError,
  ToolNotFoundError,
  ToolNotUsableError,
  ToolServerLimitError,
  ToolServerNotFoundError,
  ToolServerTakenError,
  UnknownToolError,
} from "./errors.ts";
export { saveOAuthFlow, takeOAuthFlow } from "./oauth-flows.ts";
export {
  createToolServer,
  deleteToolServer,
  findToolServer,
  findToolServerById,
  getGrants,
  listConversationTools,
  listServerGrants,
  listToolServers,
  listTools,
  type OfferedTool,
  offeredTools,
  recordSync,
  resolveToolPatterns,
  type SyncOutcome,
  setConversationTools,
  setGrants,
  type ToolRecord,
  type ToolRef,
  type ToolServerRecord,
  toolPatterns,
  uncoveredBy,
  updateTool,
  updateToolServer,
} from "./repo.ts";
