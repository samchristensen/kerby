import type { Conversation } from "@earendil-works/pi-durable";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import type { AgentMessage } from "@kerby/agent";
import {
  assistantToPi,
  type BlobReader,
  type ModelIdentity,
  toolToPi,
  userToPi,
} from "./convert.ts";

/**
 * Write `history` into a fresh conversation as Pi entries, in order, in one commit (plan 0001, S1: the model then
 * sees exactly this history, and nothing continues by itself). Returns the ids of the entries written.
 */
export async function seedHistory(
  conversation: Conversation,
  history: readonly AgentMessage[],
  identity: ModelIdentity,
  readBlob: BlobReader,
  context: Parameters<Conversation["commit"]>[1],
): Promise<Set<string>> {
  const now = Date.now();
  const toolNames = new Map<string, string>();
  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const part of message.content)
      if (part.type === "tool_call") toolNames.set(part.id, part.name);
  }
  // Convert first (it may read blobs) so the commit itself does no I/O besides storage.
  const converted = await Promise.all(
    history.map(async (message) => {
      if (message.role === "user")
        return { role: "user", pi: await userToPi(message, readBlob, now) } as const;
      if (message.role === "assistant")
        return { role: "assistant", pi: assistantToPi(message, identity, now) } as const;
      const name = toolNames.get(message.toolCallId) ?? "unknown";
      return { role: "tool", pi: await toolToPi(message, name, readBlob, now) } as const;
    }),
  );
  return conversation.commit(async (tx) => {
    const ids = new Set<string>();
    for (const item of converted) {
      const record =
        item.role === "user"
          ? await tx.appendEntry(UserEntry, conversation.id, { model: [item.pi] })
          : item.role === "assistant"
            ? await tx.appendEntry(AssistantEntry, conversation.id, { model: [item.pi] })
            : await tx.appendEntry(ToolResultEntry, conversation.id, {
                model: [item.pi],
                data: { diagnostics: [] },
              });
      ids.add(String(record.id));
    }
    return ids;
  }, context);
}
