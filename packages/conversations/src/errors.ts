export class ConversationNotFoundError extends Error {
  override name = "ConversationNotFoundError";
}

/** A turn is queued or running: one turn at a time per conversation, so a second message must wait. */
export class ConversationBusyError extends Error {
  override name = "ConversationBusyError";
}

/** This run is no longer the task's current attempt: another worker owns the turn. Stop, write nothing. */
export class LeaseLostError extends Error {
  override name = "LeaseLostError";
}

/** The message position is taken by a different message, or would leave a gap. */
export class SeqConflictError extends Error {
  override name = "SeqConflictError";
}
