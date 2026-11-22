// The tenant schema: conversations and messages, plus the order every tenant database is migrated in (ADR 0006).
import { join } from "node:path";
import { blobsMigrationsDir } from "@kerby/blobs";
import { durableMigrationsDir } from "@kerby/durable";

export const conversationsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

/** Every tenant database's migrations, in apply order: Absurd and queues, the blob index, then conversations. */
export const tenantMigrationDirs: readonly string[] = [
  durableMigrationsDir,
  blobsMigrationsDir,
  conversationsMigrationsDir,
];

export {
  ConversationBusyError,
  ConversationFullError,
  ConversationNotFoundError,
  LeaseLostError,
  SeqConflictError,
  StorageQuotaExceededError,
} from "./errors.ts";
export { type ConversationNotice, conversationChannel, notifyLive, parseNotice } from "./events.ts";
export {
  type History,
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATION_MESSAGES,
  MAX_PAGE_MESSAGES,
  type MessagePage,
  messageKey,
  type PersistInput,
  persistMessage,
  postUserMessage,
  readHistory,
  readMessages,
  type StoredMessage,
} from "./messages.ts";
export {
  type ConversationRecord,
  findConversation,
  insertConversation,
  isBusy,
  isConversationId,
  listMessageRows,
  type MessageRowRecord,
  recordToolExecution,
  setLastError,
} from "./repo.ts";
