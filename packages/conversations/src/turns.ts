// A turn's beginning and its one outcome, as events (ADR 0019). A turn is named by the user message it answers (`seq`).
import type { TURN_FAILURE_REASONS } from "@kerby/contracts";
import type { TenantContext } from "@kerby/db";
import { holdsRun, type RunContext } from "@kerby/durable";
import { announceEvents, recordEvent } from "@kerby/events";
import type { ConversationRecord } from "./repo.ts";

/** Record `turn.started` once, however many attempts the turn takes. */
export async function recordTurnStarted(
  ctx: TenantContext,
  conversation: Pick<ConversationRecord, "id" | "integrationId">,
  seq: number,
): Promise<void> {
  await recordEvent(ctx.db, {
    type: "turn.started",
    integrationId: conversation.integrationId,
    dedupeKey: `turn:${conversation.id}:${seq}:started`,
    data: { conversationId: conversation.id, seq },
  });
  await announceEvents(ctx.db);
}

export type TurnOutcome =
  /** Answered; `lastSeq` is its last message. */
  | { type: "completed"; lastSeq: number }
  /** Guardrails blocked the user message; `lastSeq` is the refusal written in the assistant's place. */
  | { type: "blocked"; lastSeq: number; guardrails: readonly string[] }
  /** No answer will come. `error` is shown to the tenant: scrub it of any key first. */
  | { type: "failed"; reason: (typeof TURN_FAILURE_REASONS)[number]; error: string };

/**
 * End a turn: its outcome event, and on failure why, kept on the conversation (`last_error`, cleared by the next post),
 * in one transaction. Fenced like `persistMessage`: a run that no longer holds its task writes nothing and gets false,
 * and a turn has one outcome however often this is called.
 */
export async function recordTurnOutcome(
  ctx: TenantContext,
  input: {
    conversation: Pick<ConversationRecord, "id" | "integrationId">;
    seq: number;
    run: Pick<RunContext, "taskId" | "runId" | "queue">;
    outcome: TurnOutcome;
  },
): Promise<boolean> {
  const { conversation, seq, outcome } = input;
  const conversationId = conversation.id;
  const common = {
    integrationId: conversation.integrationId,
    dedupeKey: `turn:${conversationId}:${seq}:outcome`,
  };
  const recorded = await ctx.db.transaction(async (tx) => {
    if (!(await holdsRun(tx, input.run))) return false;
    switch (outcome.type) {
      case "completed":
        await recordEvent(tx, {
          ...common,
          type: "turn.completed",
          data: { conversationId, seq, lastSeq: outcome.lastSeq },
        });
        break;
      case "blocked":
        await recordEvent(tx, {
          ...common,
          type: "turn.blocked",
          data: {
            conversationId,
            seq,
            lastSeq: outcome.lastSeq,
            guardrails: [...outcome.guardrails],
          },
        });
        break;
      case "failed":
        await tx.query("update conversations set last_error = $2 where id = $1", [
          conversationId,
          outcome.error,
        ]);
        await recordEvent(tx, {
          ...common,
          type: "turn.failed",
          data: { conversationId, seq, reason: outcome.reason, error: outcome.error },
        });
        break;
    }
    return true;
  });
  if (recorded) await announceEvents(ctx.db);
  return recorded;
}
