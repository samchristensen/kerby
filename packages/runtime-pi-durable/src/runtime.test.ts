import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, AgentMessage, AgentRun, ToolCall, ToolResult } from "@kerby/agent";
import { describe, expect, it } from "vitest";
import { createFakeModels, createPiDurableRuntime, FAKE_MODEL, unresolvedCalls } from "./index.ts";

const text = (value: string) => [{ type: "text", text: value }] as const;
const user = (value: string): AgentMessage => ({ role: "user", content: [...text(value)] });

const echoSpec = {
  name: "echo",
  description: "Echo the text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  readOnly: false,
};

function setup() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = createPiDurableRuntime({ models, modelRetry: { maxRetries: 1, baseDelayMs: 1 } });
  return { faux, runtime, model: `${faux.getModel().provider}/${faux.getModel().id}` };
}

function makeRun(overrides: Partial<AgentRun> & Pick<AgentRun, "model" | "history">): AgentRun {
  return {
    system: "Be brief.",
    tools: [],
    executeTool: async () => {
      throw new Error("no tool expected");
    },
    readBlob: async () => {
      throw new Error("no blob expected");
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  events: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => Promise<void>,
): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    await onEvent?.(event);
  }
  return seen;
}

/** What the model was shown, without Pi's leading system entries. */
const shown = (context: { messages: readonly { role: string }[] }) =>
  context.messages.filter((m) => m.role !== "system");

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const messages = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "message_end" ? [e.message] : []));

describe("text-only run", () => {
  it("streams text and reports one assistant message, with no user or system messages", async () => {
    const { faux, runtime, model } = setup();
    faux.setResponses([fauxAssistantMessage("Hello there")]);
    const events = await collect(runtime.run(makeRun({ model, history: [user("hi")] })));

    expect(types(events)[0]).toBe("run_start");
    expect(events.at(-1)).toEqual({ type: "run_end", reason: "done" });
    const streamed = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
    expect(streamed).toBe("Hello there");

    const ended = messages(events);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      role: "assistant",
      model,
      stopReason: "end",
      content: [{ type: "text", text: "Hello there" }],
    });
    expect(ended[0]).toHaveProperty("native");
    // message_start precedes message_end, deltas sit between them
    const order = types(events).filter((t) => t !== "text_delta");
    expect(order).toEqual(["run_start", "message_start", "message_end", "run_end"]);
  });

  it("ends at once when history already ends with a finished assistant message", async () => {
    const { runtime, model } = setup();
    const history: AgentMessage[] = [
      user("hi"),
      { role: "assistant", model, stopReason: "end", content: [...text("done already")] },
    ];
    const events = await collect(runtime.run(makeRun({ model, history })));
    expect(types(events)).toEqual(["run_start", "run_end"]);
  });

  it("does not show the model the continue sentinel, and passes the system prompt", async () => {
    const { faux, runtime, model } = setup();
    let seen: { roles: string[]; system: string | undefined } | undefined;
    faux.setResponses([
      (context) => {
        seen = {
          roles: shown(context).map((m) => m.role),
          system: JSON.stringify(context.messages.filter((m) => m.role === "system")),
        };
        return fauxAssistantMessage("ok");
      },
    ]);
    await collect(runtime.run(makeRun({ model, history: [user("hi")], system: "Only say ok." })));
    expect(seen?.roles).toEqual(["user"]);
    expect(seen?.system).toContain("Only say ok.");
  });
});

describe("tool run", () => {
  it("runs the tool once through executeTool and reports events in order", async () => {
    const { faux, runtime, model } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "ping" }, { id: "call_1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("It said ping"),
    ]);
    const executed: ToolCall[] = [];
    const run = makeRun({
      model,
      history: [user("echo ping")],
      tools: [echoSpec],
      executeTool: async (call): Promise<ToolResult> => {
        executed.push(call);
        return { content: [...text("ping")], isError: false };
      },
    });
    const events = await collect(runtime.run(run));

    expect(executed).toEqual([
      { type: "tool_call", id: "call_1", name: "echo", input: { text: "ping" } },
    ]);
    const order = types(events).filter((t) => t !== "text_delta");
    expect(order).toEqual([
      "run_start",
      "message_start",
      "message_end", // assistant with the call
      "tool_start",
      "tool_end",
      "message_end", // tool result
      "message_start",
      "message_end", // final assistant
      "run_end",
    ]);
    const ended = messages(events);
    expect(ended[0]).toMatchObject({ role: "assistant", stopReason: "tool_use" });
    expect(ended[1]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "text", text: "ping" }],
      isError: false,
    });
    expect(ended[2]).toMatchObject({ role: "assistant", stopReason: "end" });
  });

  it("gives the model an error result when the tool reports an error", async () => {
    const { faux, runtime, model } = setup();
    let secondRequest: string[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "x" }, { id: "call_1" })], {
        stopReason: "toolUse",
      }),
      (context) => {
        secondRequest = shown(context).map((m) =>
          m.role === "toolResult" && "isError" in m ? `toolResult:${m.isError}` : m.role,
        );
        return fauxAssistantMessage("sorry");
      },
    ]);
    const run = makeRun({
      model,
      history: [user("go")],
      tools: [echoSpec],
      executeTool: async () => ({ content: [...text("disk full")], isError: true }),
    });
    const events = await collect(runtime.run(run));
    expect(secondRequest).toEqual(["user", "assistant", "toolResult:true"]);
    expect(messages(events)[1]).toMatchObject({ role: "tool", isError: true });
  });

  it("does not run a tool until the message that asked for it was consumed", async () => {
    const { faux, runtime, model } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "a" }, { id: "call_1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    let persisted = false;
    let persistedWhenToolRan: boolean | undefined;
    const run = makeRun({
      model,
      history: [user("go")],
      tools: [echoSpec],
      executeTool: async () => {
        persistedWhenToolRan = persisted;
        return { content: [...text("a")], isError: false };
      },
    });
    await collect(runtime.run(run), async (event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "tool_use"
      ) {
        // A real delay on purpose: the tool must not start while the supervisor is still persisting.
        await new Promise((resolve) => setTimeout(resolve, 200));
        persisted = true;
      }
    });
    expect(persistedWhenToolRan).toBe(true);
  });
});

describe("rehydration from history", () => {
  const assistantWithCall = (model: string): AgentMessage => ({
    role: "assistant",
    model,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id: "call_1", name: "echo", input: { text: "a" } }],
  });

  it("finishes a run whose tool call and result were already persisted, without repeating the call", async () => {
    const { faux, runtime, model } = setup();
    let request: string[] = [];
    faux.setResponses([
      (context) => {
        request = shown(context).map((m) => m.role);
        return fauxAssistantMessage("finished");
      },
    ]);
    const history: AgentMessage[] = [
      user("go"),
      assistantWithCall(model),
      { role: "tool", toolCallId: "call_1", content: [...text("a")], isError: false },
    ];
    let executed = 0;
    const run = makeRun({
      model,
      history,
      tools: [echoSpec],
      executeTool: async () => {
        executed++;
        return { content: [...text("again")], isError: false };
      },
    });
    const events = await collect(runtime.run(run));
    expect(executed).toBe(0);
    expect(request).toEqual(["user", "assistant", "toolResult"]);
    expect(messages(events)).toHaveLength(1);
    expect(messages(events)[0]).toMatchObject({ role: "assistant", stopReason: "end" });
  });

  it("resolves a persisted call that has no result through executeTool before continuing", async () => {
    const { faux, runtime, model } = setup();
    let request: string[] = [];
    faux.setResponses([
      (context) => {
        request = shown(context).map((m) =>
          m.role === "toolResult" && "content" in m
            ? `toolResult:${JSON.stringify(m.content)}`
            : m.role,
        );
        return fauxAssistantMessage("finished");
      },
    ]);
    const executed: string[] = [];
    const run = makeRun({
      model,
      history: [user("go"), assistantWithCall(model)],
      tools: [echoSpec],
      executeTool: async (call) => {
        executed.push(call.id);
        return { content: [...text("A")], isError: false };
      },
    });
    const events = await collect(runtime.run(run));
    expect(executed).toEqual(["call_1"]);
    expect(messages(events)[0]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: [{ type: "text", text: "A" }],
      isError: false,
    });
    expect(request).toEqual(["user", "assistant", 'toolResult:[{"type":"text","text":"A"}]']);
    expect(events.at(-1)).toEqual({ type: "run_end", reason: "done" });
  });

  it("replays a message's native payload so a new process continues faithfully", async () => {
    const first = setup();
    first.faux.setResponses([fauxAssistantMessage("first answer")]);
    const firstEvents = await collect(
      first.runtime.run(makeRun({ model: first.model, history: [user("one")] })),
    );
    const persisted = messages(firstEvents);

    // "Crash": a brand new runtime and provider are given only the persisted messages.
    const second = setup();
    let request: { role: string; stopReason?: string }[] = [];
    second.faux.setResponses([
      (context) => {
        request = shown(context).map((m) => ({
          role: m.role,
          ...("stopReason" in m ? { stopReason: String(m.stopReason) } : {}),
        }));
        return fauxAssistantMessage("second answer");
      },
    ]);
    const history = [user("one"), ...persisted, user("two")];
    const events = await collect(second.runtime.run(makeRun({ model: second.model, history })));
    expect(request).toEqual([
      { role: "user" },
      { role: "assistant", stopReason: "stop" },
      { role: "user" },
    ]);
    expect(messages(events)[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "second answer" }],
    });
  });
});

describe("how a run ends", () => {
  it("a provider's 4xx refusal ends the run as refused instead of throwing", async () => {
    const { faux, runtime, model } = setup();
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "400 invalid request: bad tool schema",
      }),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "400 invalid request: bad tool schema",
      }),
    ]);
    const events = await collect(runtime.run(makeRun({ model, history: [user("hi")] })));
    const end = events.at(-1);
    expect(end).toMatchObject({ type: "run_end", reason: "refused" });
    expect(messages(events)).toEqual([]);
  });

  it("an infrastructure failure throws so the task retries", async () => {
    const { faux, runtime, model } = setup();
    const failure = () =>
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 upstream unavailable" });
    faux.setResponses([failure(), failure(), failure()]);
    await expect(collect(runtime.run(makeRun({ model, history: [user("hi")] })))).rejects.toThrow(
      /model_error: 503/,
    );
  });

  it("an unknown model is refused, not retried", async () => {
    const { runtime } = setup();
    const events = await collect(
      runtime.run(makeRun({ model: "faux/does-not-exist", history: [user("hi")] })),
    );
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "refused" });
  });

  it("an aborted signal ends the run as aborted", async () => {
    const { faux, runtime, model } = setup();
    const controller = new AbortController();
    faux.setResponses([
      async () => {
        controller.abort();
        // A real delay on purpose: the model request is still in flight when the abort lands.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return fauxAssistantMessage("too late");
      },
    ]);
    const events = await collect(
      runtime.run(makeRun({ model, history: [user("hi")], signal: controller.signal })),
    );
    expect(events.at(-1)).toMatchObject({ type: "run_end", reason: "aborted" });
  });
});

describe("unresolvedCalls", () => {
  const call = (id: string): AgentMessage => ({
    role: "assistant",
    model: "m",
    stopReason: "tool_use",
    content: [{ type: "tool_call", id, name: "echo", input: {} }],
  });
  const result = (id: string): AgentMessage => ({
    role: "tool",
    toolCallId: id,
    content: [],
    isError: false,
  });

  it("finds the calls of the last assistant message that have no result", () => {
    expect(unresolvedCalls([user("a"), call("1")]).map((c) => c.id)).toEqual(["1"]);
    expect(unresolvedCalls([user("a"), call("1"), result("1")])).toEqual([]);
  });

  it("ignores calls abandoned by a later user message", () => {
    expect(unresolvedCalls([user("a"), call("1"), user("never mind")])).toEqual([]);
  });
});

describe("fake model", () => {
  const fake = () => ({
    runtime: createPiDurableRuntime({ models: createFakeModels() }),
    model: FAKE_MODEL,
  });

  it("echoes a plain message", async () => {
    const { runtime, model } = fake();
    const events = await collect(runtime.run(makeRun({ model, history: [user("hello")] })));
    expect(messages(events)[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Echo: hello" }],
    });
  });

  it("calls the echo tool for `echo ...` and reports what the tool said, from any rehydrated point", async () => {
    const { runtime, model } = fake();
    const executed: string[] = [];
    const run = (history: AgentMessage[]) =>
      makeRun({
        model,
        history,
        tools: [echoSpec],
        executeTool: async (call) => {
          executed.push(call.id);
          return {
            content: [{ type: "text", text: String((call.input as { text: string }).text) }],
            isError: false,
          };
        },
      });
    const first = messages(await collect(runtime.run(run([user("echo ping")]))));
    expect(first.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(first[2]).toMatchObject({ content: [{ text: "Tool said: ping" }] });

    // The same answer when a new process resumes after the tool result was persisted.
    const resumed = messages(
      await collect(runtime.run(run([user("echo ping"), ...first.slice(0, 2)]))),
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ content: [{ text: "Tool said: ping" }] });
    expect(executed).toEqual(["call_1"]);
  });
});
