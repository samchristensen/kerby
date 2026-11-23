// Prompts (ADR 0017): the tenant tables of named, versioned prompts, their repo, and `{{variable}}` rendering.
import { join } from "node:path";

/** The prompt tables' migrations; `tenantMigrationDirs` (packages/conversations) applies them after conversations. */
export const promptsMigrationsDir = join(import.meta.dirname, "..", "migrations", "tenant");

export {
  DraftConflictError,
  NotPublishableError,
  PromptKindError,
  PromptLimitError,
  PromptNameTakenError,
  PromptNotFoundError,
  PromptPublishedError,
  PromptUnchangedError,
  ReservedLabelError,
} from "./errors.ts";
export {
  createPrompt,
  deletePrompt,
  getPrompt,
  getPromptVersion,
  listPrompts,
  publishPrompt,
  removePromptLabel,
  renamePrompt,
  saveDraft,
  setPromptLabel,
} from "./repo.ts";
export { StorageQuotaExceededError, storedBytes } from "./storage.ts";
export {
  InvalidVariablesError,
  publishProblems,
  renderTemplate,
  templateVariables,
} from "./template.ts";
