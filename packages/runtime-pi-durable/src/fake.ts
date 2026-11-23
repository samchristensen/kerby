// A scripted model for local stacks and end-to-end tests (`KERBY_FAKE_MODEL=1`, never in production): the answer
// depends on the last message only, so a rehydrated run answers exactly as the original would have.
//   "echo <text>"            asks for the built-in echo tool (`kerby__echo`; the conversation must name `kerby/echo`)
//                            with <text>, then reports what the tool said
//   "call <tool> <json>"     asks for the tool the model knows as <tool> (`<server>__<tool>`) with the JSON object as its
//                            input (`{}` when there is none), then reports what the tool said
//   "describe <tool>"        answers with the description the model was given for <tool>, or that it was given none
//   "list tools"             answers with the names of the tools the model was given, in order
//   anything else            "Echo: <text>"
//   "[slow:<ms>]"            in the user message: wait before answering (a window to kill a worker in)
//   "[slow-after-tool:<ms>]" the same, but only for the answer that follows a tool result
//   "[think:<text>]"         in the user message: the answer starts with a reasoning block holding <text>
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, type JsonObject, type Models } from "@earendil-works/pi-ai";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export const FAKE_MODEL = "fake/fake-1";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function delayOf(text: string, marker: "slow" | "slow-after-tool"): number {
  const match = new RegExp(`\\[${marker}:(\\d+)\\]`).exec(text);
  return match?.[1] ? Number(match[1]) : 0;
}

export function createFakeModels(): Models {
  const faux = fauxProvider({ provider: "fake", models: [{ id: "fake-1", name: "Fake" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const respond: FauxResponseFactory = async (context, options) => {
    // The factory is its own queue: each call schedules the next.
    faux.appendResponses([respond]);
    const messages = context.messages.filter((m) => m.role !== "system");
    const last = messages.at(-1);
    const firstUser = textOf(messages.find((m) => m.role === "user")?.content);
    if (last?.role === "toolResult") {
      await sleep(delayOf(firstUser, "slow-after-tool"), undefined, {
        signal: options?.signal,
      }).catch(() => {});
      return fauxAssistantMessage(`Tool said: ${textOf(last.content)}`);
    }
    const text = textOf(last?.content);
    await sleep(delayOf(text, "slow"), undefined, { signal: options?.signal }).catch(() => {});
    const thought = /\[think:([^\]]*)\]/.exec(text)?.[1];
    const thinking = thought === undefined ? [] : [fauxThinking(thought)];
    const script = text.replace(/\[slow:\d+\]|\[think:[^\]]*\]/g, "").trim();
    const echo = /^echo (.*)$/s.exec(script);
    const call = /^call ([A-Za-z0-9_-]+)(?:\s+(.*))?$/s.exec(script);
    const toolCall = (name: string, input: JsonObject) =>
      fauxAssistantMessage(
        [...thinking, fauxToolCall(name, input, { id: `call_${messages.length}` })],
        { stopReason: "toolUse" },
      );
    if (echo?.[1] !== undefined) return toolCall("kerby__echo", { text: echo[1] });
    if (call?.[1] !== undefined) {
      let input: unknown;
      try {
        input = JSON.parse(call[2] ?? "{}");
      } catch {
        return fauxAssistantMessage(`Not JSON: ${call[2] ?? ""}`);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input))
        return fauxAssistantMessage(`Not a JSON object: ${call[2] ?? ""}`);
      // Parsed from JSON text, so every value in it is JSON.
      const object: JsonObject = input as JsonObject;
      return toolCall(call[1], object);
    }
    // The tools offered: system messages add and remove them in order (pi-ai's transcript).
    const offered = new Map<string, string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const removed of message.toolsRemoved ?? []) offered.delete(removed.name);
      for (const added of message.toolsAdded ?? []) offered.set(added.name, added.description);
    }
    const describe = /^describe ([A-Za-z0-9_-]+)$/.exec(script)?.[1];
    if (describe !== undefined) {
      const description = offered.get(describe);
      return fauxAssistantMessage(
        description === undefined
          ? `No tool "${describe}" was given.`
          : `Described: ${description}`,
      );
    }
    if (script === "list tools")
      return fauxAssistantMessage(`Tools: ${[...offered.keys()].join(", ")}`);
    const reply = text.replace(/\[slow(?:-after-tool)?:\d+\]|\[think:[^\]]*\]/g, "").trim();
    return fauxAssistantMessage([...thinking, fauxText(`Echo: ${reply}`)]);
  };
  faux.setResponses([respond]);
  return models;
}
