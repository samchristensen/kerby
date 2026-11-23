// Guardrails (ADR 0016): yes/no conditions a conversation carries, checked by a judgment before the assistant acts on a
// user message or runs a tool. They fail closed: a check that cannot run (no key, a refusal) means nothing is answered or
// run; an infrastructure failure throws, so the turn retries.

import type { ToolCall, ToolResult } from "@kerby/agent";
import { DEFAULT_JUDGMENT_MODEL, type Guardrail } from "@kerby/contracts";
import { blockMessage, type ConversationRecord, readMessages } from "@kerby/conversations";
import type { TenantContext } from "@kerby/db";
import type { RunContext } from "@kerby/durable";
import type { JsonValue } from "@kerby/judgment";
import type { WorkerDeps } from "../types/index.ts";
import { runJudgment } from "./judgments.ts";

/**
 * `blocked`: these guardrails fired (their probability of yes reached `blockAt`). `unavailable`: the check could not run
 * and the same request would fail the same way until the tenant fixes something, so there is no retry; `error` says what.
 * The value is stored as a step result: small JSON.
 */
export type Verdict =
  | { type: "allowed" }
  | { type: "blocked"; by: string[] }
  | { type: "unavailable"; error: string };

const applying = (conversation: ConversationRecord, to: Guardrail["appliesTo"]): Guardrail[] =>
  conversation.guardrails.filter((guardrail) => guardrail.appliesTo === to);

/** One request for the guardrails that share a model (they run in parallel), each answer compared with its own threshold. */
async function judgeWith(
  deps: WorkerDeps,
  tenantId: string,
  usageKey: string,
  model: string,
  guardrails: Guardrail[],
  state: JsonValue,
  signal: AbortSignal,
): Promise<Verdict> {
  const outcome = await runJudgment(
    deps,
    tenantId,
    usageKey,
    {
      model,
      state,
      questions: Object.fromEntries(
        guardrails.map((g) => [
          g.name,
          {
            type: "noul",
            instructions: g.instructions,
            ...(g.criteria === undefined ? {} : { criteria: g.criteria }),
          },
        ]),
      ),
    },
    signal,
  );
  if (outcome.type === "refused") return { type: "unavailable", error: outcome.error };
  const by: string[] = [];
  for (const guardrail of guardrails) {
    const answer = outcome.answers[guardrail.name];
    if (answer?.type !== "noul")
      throw new Error(`the provider returned no yes/no answer for guardrail "${guardrail.name}"`);
    if (answer.probability >= guardrail.blockAt) by.push(guardrail.name);
  }
  return by.length > 0 ? { type: "blocked", by } : { type: "allowed" };
}

/**
 * Every guardrail, one request per judgment model (`model`, else the default), in parallel. A block anywhere blocks; failing
 * that, a check that could not run makes the whole check unavailable (fail closed); otherwise allowed.
 */
async function judge(
  deps: WorkerDeps,
  tenantId: string,
  usageKey: string,
  guardrails: Guardrail[],
  state: JsonValue,
  signal: AbortSignal,
): Promise<Verdict> {
  const byModel = Map.groupBy(guardrails, (guardrail) => guardrail.model ?? DEFAULT_JUDGMENT_MODEL);
  const verdicts = await Promise.all(
    [...byModel].map(([model, group]) =>
      judgeWith(deps, tenantId, `${usageKey}:${model}`, model, group, state, signal),
    ),
  );
  const by = verdicts.flatMap((verdict) => (verdict.type === "blocked" ? verdict.by : []));
  if (by.length > 0) return { type: "blocked", by };
  const unavailable = verdicts.find((verdict) => verdict.type === "unavailable");
  return unavailable ?? { type: "allowed" };
}

/** A message's text parts joined; a part that is not text (an image) is not judged. */
async function textOfMessage(
  ctx: TenantContext,
  deps: WorkerDeps,
  conversationId: string,
  seq: number,
): Promise<string> {
  const page = await readMessages(ctx, deps.blobs, conversationId, { after: seq - 1, limit: 1 });
  const stored = page.messages[0];
  if (stored?.seq !== seq || stored.message.role !== "user")
    throw new Error(`message ${seq} of conversation ${conversationId} is not a user message`);
  return stored.message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Check the user message that started this turn against the conversation's `user_message` guardrails, once per task (a
 * step: a retry gets the stored verdict and does not ask, or pay, again). A blocking verdict flags the message in the same
 * step (fenced to the run), so no later turn rehydrates it.
 */
export async function checkUserMessage(
  deps: WorkerDeps,
  ctx: TenantContext,
  conversation: ConversationRecord,
  seq: number,
  run: RunContext,
): Promise<Verdict> {
  const guardrails = applying(conversation, "user_message");
  if (guardrails.length === 0) return { type: "allowed" };
  return run.step("guardrail:user_message", async () => {
    const message = await textOfMessage(ctx, deps, conversation.id, seq);
    // Nothing the judge can read (an image only): the guardrails have nothing to say about it.
    if (message === "") return { type: "allowed" };
    const verdict = await judge(
      deps,
      ctx.tenantId,
      `guardrail:${conversation.id}:${seq}`,
      guardrails,
      { message },
      run.signal,
    );
    if (verdict.type === "blocked")
      await blockMessage(ctx, { conversationId: conversation.id, seq, blockedBy: verdict.by, run });
    return verdict;
  });
}

const refusedTool = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * Check a tool call (its name and input) against the conversation's `tool_call` guardrails. Returns the result the model
 * gets instead of the tool's when the call must not run, or undefined to let it run. Call it inside the tool's step.
 */
export async function guardToolCall(
  deps: WorkerDeps,
  tenantId: string,
  conversation: ConversationRecord,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolResult | undefined> {
  const guardrails = applying(conversation, "tool_call");
  if (guardrails.length === 0) return undefined;
  // What the model wrote, as JSON: `undefined` and other non-JSON values the harness may hold do not survive the trip.
  const input: JsonValue = JSON.parse(JSON.stringify(call.input ?? null));
  const verdict = await judge(
    deps,
    tenantId,
    `guardrail:${conversation.id}:${call.id}`,
    guardrails,
    { tool_call: { name: call.name, input } },
    signal,
  );
  if (verdict.type === "blocked")
    return refusedTool(
      `The tool "${call.name}" was not run: blocked by guardrail ${verdict.by.map((n) => `"${n}"`).join(", ")}.`,
    );
  if (verdict.type === "unavailable")
    return refusedTool(
      `The tool "${call.name}" was not run: a guardrail could not be checked (${verdict.error}).`,
    );
  return undefined;
}
