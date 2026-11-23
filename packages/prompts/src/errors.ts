/** No prompt by that name, or no such version or label of it. */
export class PromptNotFoundError extends Error {
  override name = "PromptNotFoundError";
}

/** Another prompt of the tenant has the name. */
export class PromptNameTakenError extends Error {
  override name = "PromptNameTakenError";
}

/** The tenant has `MAX_PROMPTS` prompts, or the prompt `MAX_PROMPT_VERSIONS` versions. */
export class PromptLimitError extends Error {
  override name = "PromptLimitError";
}

/** The prompt has a published version, so clients may depend on its name: it cannot be renamed or deleted. */
export class PromptPublishedError extends Error {
  override name = "PromptPublishedError";
}

/** The draft moved on since the revision the caller started from: someone else saved in between. */
export class DraftConflictError extends Error {
  override name = "DraftConflictError";
}

/** A body or a use of the other kind: a decision body for a chat prompt, a decision prompt for a conversation. */
export class PromptKindError extends Error {
  override name = "PromptKindError";
}

/** The draft fails the publish checks; the message lists every problem. */
export class NotPublishableError extends Error {
  override name = "NotPublishableError";
  constructor(problems: string[]) {
    super(`the draft cannot be published: ${problems.join("; ")}`);
  }
}

/** The draft is the latest version already: there is nothing to publish. */
export class PromptUnchangedError extends Error {
  override name = "PromptUnchangedError";
}

/** The label is `latest`, which every prompt has and nobody sets or removes. */
export class ReservedLabelError extends Error {
  override name = "ReservedLabelError";
}
