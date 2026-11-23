// The tenant schema: conversations and messages, plus the order every tenant database is migrated in (ADR 0006).
import { join } from "node:path";
import { blobsMigrationsDir } from "@kerby/blobs";
import { durableMigrationsDir } from "@kerby/durable";
import { promptsMigrationsDir } from "@kerby/prompts";

const conversationsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

/** Every tenant database's migrations, in apply order: Absurd and queues, the blob index, conversations, then prompts. */
export const tenantMigrationDirs: readonly string[] = [
  durableMigrationsDir,
  blobsMigrationsDir,
  conversationsMigrationsDir,
  promptsMigrationsDir,
];

export {
  ConversationBusyError,
  ConversationFullError,
  ConversationNotFoundError,
  InvalidCursorError,
  LeaseLostError,
  SeqConflictError,
} from "./errors.ts";
export { conversationChannel, notifyLive, parseNotice } from "./events.ts";
export {
  blockMessage,
  MAX_CONVERSATION_BYTES,
  MAX_PAGE_MESSAGES,
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
  listConversations,
  recordToolExecution,
  setLastError,
} from "./repo.ts";
