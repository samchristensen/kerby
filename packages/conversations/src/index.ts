// The tenant schema: conversations and messages, plus the order every tenant database is migrated in (ADR 0006).
import { join } from "node:path";
import { blobsMigrationsDir } from "@kerby/blobs";
import { durableMigrationsDir } from "@kerby/durable";
import { eventsMigrationsDir } from "@kerby/events";
import { promptsMigrationsDir } from "@kerby/prompts";
import { searchMigrationsDir } from "@kerby/search";

const conversationsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

/**
 * Every tenant database's migrations, in apply order: Absurd and queues, the blob index, conversations, prompts, the
 * event log, then the search index over conversations' messages (ADR 0021).
 */
export const tenantMigrationDirs: readonly string[] = [
  durableMigrationsDir,
  blobsMigrationsDir,
  conversationsMigrationsDir,
  promptsMigrationsDir,
  eventsMigrationsDir,
  searchMigrationsDir,
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
  listConversations,
  recordToolExecution,
} from "./repo.ts";
export { appendTrace, readTrace } from "./trace.ts";
export { recordTurnOutcome, recordTurnStarted, type TurnOutcome } from "./turns.ts";
