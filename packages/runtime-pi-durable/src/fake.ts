// A scripted model for local stacks and end-to-end tests (`KERBY_FAKE_MODEL=1`, never in production): the answer
// depends on the last message only, so a rehydrated run answers exactly as the original would have.
//   "echo <text>"            asks for the `echo` tool with <text>, then reports what the tool said
//   anything else            "Echo: <text>"
//   "[slow:<ms>]"            in the user message: wait before answering (a window to kill a worker in)
//   "[slow-after-tool:<ms>]" the same, but only for the answer that follows a tool result
//   "[think:<text>]"         in the user message: the answer starts with a reasoning block holding <text>
import { setTimeout as sleep } from "node:timers/promises";
import { createModels, type Models } from "@earendil-works/pi-ai";
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
    const echo = /^echo (.*)$/s.exec(text.replace(/\[slow:\d+\]|\[think:[^\]]*\]/g, "").trim());
    if (echo?.[1] !== undefined) {
      return fauxAssistantMessage(
        [...thinking, fauxToolCall("echo", { text: echo[1] }, { id: `call_${messages.length}` })],
        {
          stopReason: "toolUse",
        },
      );
    }
    const reply = text.replace(/\[slow(?:-after-tool)?:\d+\]|\[think:[^\]]*\]/g, "").trim();
    return fauxAssistantMessage([...thinking, fauxText(`Echo: ${reply}`)]);
  };
  faux.setResponses([respond]);
  return models;
}
