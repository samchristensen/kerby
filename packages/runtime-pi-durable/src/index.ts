// The Pi Durable adapter for the AgentRuntime port (ADR 0003). Every run opens a fresh in-memory harness,
// seeds it from `AgentRun.history`, continues it, and maps its events to `AgentEvent`s. Nothing Pi stores
// outlives the run: Kerby persists what `message_end` reports and rebuilds the harness from that.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import {
  type AgentEventStream,
  type Conversation,
  type Cursor,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type AgentEvent as PiEvent,
  watchEvents,
} from "@earendil-works/pi-durable";
import type {
  AgentEvent,
  AgentMessage,
  AgentRun,
  AgentRuntime,
  ToolCall,
  ToolResult,
} from "@kerby/agent";
import {
  assistantFromPi,
  type ModelIdentity,
  textOf,
  toolFromPi,
  toolResultFromPi,
  toPiMedia,
} from "./convert.ts";
import { Gates } from "./gates.ts";
import { classifyUnanswered } from "./outcome.ts";
import { AsyncQueue } from "./queue.ts";
import { seedHistory } from "./seed.ts";
import { TextForwarder } from "./text.ts";

export { createFakeModels, FAKE_MODEL } from "./fake.ts";
export { createTenantModels, SUPPORTED_PROVIDERS } from "./providers.ts";

export type PiDurableOptions = {
  /**
   * The model catalog and credentials. A fixed `Models` (the development fake, a test's faux provider) serves every
   * run; a function builds one per run from the provider and the caller's own key, or returns undefined when the
   * provider is unknown or no key was given.
   */
  models: Models | ((provider: string, apiKey: string | undefined) => Models | undefined);
  /** Kerby model id to Pi's provider and model id. Default: `<provider>/<modelId>`, split at the first slash. */
  resolveModel?: (kerbyModel: string) => { provider: string; modelId: string };
  /** Retry policy for failed model requests inside a run. Default: 2 retries, 1 s base delay. */
  modelRetry?: { maxRetries: number; baseDelayMs: number };
  /** Pi reports what it handled itself (a failed model request, a throwing hook). Only the report type: content never reaches logs. */
  onReport?: (type: string) => void;
};

function defaultResolve(kerbyModel: string): { provider: string; modelId: string } {
  const slash = kerbyModel.indexOf("/");
  if (slash <= 0 || slash === kerbyModel.length - 1) {
    throw new Error(`model "${kerbyModel}" must look like <provider>/<modelId>`);
  }
  return { provider: kerbyModel.slice(0, slash), modelId: kerbyModel.slice(slash + 1) };
}

/** What the run's queue carries: Pi's events, then how the input ended. */
type Queued =
  | { kind: "event"; event: PiEvent }
  | { kind: "settled"; status: "done" | "unanswered"; reason: string; detail: unknown }
  | { kind: "failed"; error: unknown };

/** Calls of the last assistant message in `history` that have no tool message after it. */
export function unresolvedCalls(history: readonly AgentMessage[]): ToolCall[] {
  const lastAssistant = history.findLastIndex((message) => message.role === "assistant");
  const message = history[lastAssistant];
  if (message?.role !== "assistant") return [];
  const after = history.slice(lastAssistant + 1);
  // A user message after the assistant means the calls were abandoned; do not run them now.
  if (after.some((m) => m.role === "user")) return [];
  const answered = new Set(after.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  return message.content.filter(
    (part): part is ToolCall => part.type === "tool_call" && !answered.has(part.id),
  );
}

export function createPiDurableRuntime(options: PiDurableOptions): AgentRuntime {
  const resolve = options.resolveModel ?? defaultResolve;
  return { name: "pi-durable", run: (run) => runPi(options, resolve, run) };
}

async function* runPi(
  options: PiDurableOptions,
  resolve: (kerbyModel: string) => { provider: string; modelId: string },
  run: AgentRun,
): AsyncGenerator<AgentEvent> {
  yield { type: "run_start" };
  if (run.signal.aborted) {
    yield { type: "run_end", reason: "aborted" };
    return;
  }

  // 1. Tool calls the history left unanswered (a crash between an assistant message and its result): run
  //    them through Kerby first, as its cached step, and report the results so they are persisted.
  const history = [...run.history];
  for (const call of unresolvedCalls(history)) {
    yield { type: "tool_start", call };
    const result = await run.executeTool(call, run.signal);
    yield { type: "tool_end", call, result };
    const message: AgentMessage = {
      role: "tool",
      toolCallId: call.id,
      content: result.content,
      isError: result.isError,
    };
    yield { type: "message_end", message };
    history.push(message);
  }
  const last = history.at(-1);
  if (!last) throw new Error("AgentRun.history is empty: there is nothing to continue");
  if (last.role === "assistant" && !last.content.some((part) => part.type === "tool_call")) {
    yield { type: "run_end", reason: "done" };
    return;
  }

  // 2. A fresh harness with Kerby's tools, continuing from history.
  const ref = resolve(run.model);
  const models =
    typeof options.models === "function"
      ? options.models(ref.provider, run.apiKey)
      : options.models;
  const model = models?.getModel(ref.provider, ref.modelId);
  if (!models || !model) {
    // The same request gets the same answer: no retry.
    yield { type: "run_end", reason: "refused", error: `model ${run.model} is not available` };
    return;
  }
  const identity: ModelIdentity = { api: model.api, provider: ref.provider, modelId: ref.modelId };
  const sentinel = `kerby-continue:${crypto.randomUUID()}`;
  const gates = new Gates();
  const ownResults = new Map<string, ToolResult>();
  const calls = new Map<string, ToolCall>();

  const tools = run.tools.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: Type.Unsafe(spec.inputSchema),
      execute: async (args, api) => {
        // Persist before act: wait until the supervisor consumed the message that holds this call.
        await gates.wait(api.callId);
        const call: ToolCall = { type: "tool_call", id: api.callId, name: spec.name, input: args };
        const result = await run.executeTool(call, run.signal);
        ownResults.set(api.callId, result);
        if (result.isError) throw new Error(textOf(result.content));
        return { output: await toPiMedia(result.content, run.readBlob) };
      },
    }),
  );
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "kerby",
      tools,
      hooks: [
        hook(GenerationTask, {
          // Pi has no "continue without input": a sentinel input starts the run and no model sees it.
          beforeRequest: (request) => ({
            messages: request.messages.filter(
              (m) => !(m.role === "user" && m.content === sentinel),
            ),
          }),
        }),
      ],
    }),
  );

  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      onReport: (_error, info) => options.onReport?.(info.type),
      settings: { retry: options.modelRetry ?? { maxRetries: 2, baseDelayMs: 1000 } },
    },
    context,
  );
  const queue = new AsyncQueue<Queued>();
  let root: Conversation | undefined;
  let stream: AgentEventStream | undefined;
  const onAbort = () => void root?.abort(context).catch(() => {});
  try {
    root = await harness.root(context, { agent: { model: ref, instructions: run.system } });
    const seeded = await seedHistory(root, history, identity, run.readBlob, context);
    stream = await watchEvents(harness, root.id, context);
    stream.start(async (events) => {
      for (const event of events) queue.push({ kind: "event", event });
    });
    run.signal.addEventListener("abort", onAbort, { once: true });

    const submission = await root.submit({ type: "input", content: sentinel }, context);
    submission.wait(context).then(
      (settled) =>
        queue.push({
          kind: "settled",
          status: settled.status,
          reason: settled.reason ?? "",
          detail: settled.detail,
        }),
      (error: unknown) => queue.push({ kind: "failed", error }),
    );

    // 3. Map events one at a time. The generator suspends at each `yield` until the supervisor asks for the
    //    next event: that is how "persisted before the tool runs" holds, since a message's tool gates open
    //    only after the pull that follows its `message_end`.
    const text = new TextForwarder();
    const emitted = new Set(seeded);
    const toKerby = (entry: EntryRecord): AgentMessage | undefined => {
      const pi = entry.model?.[0];
      if (pi?.role === "assistant") return assistantFromPi(pi, run.model);
      if (pi?.role === "toolResult") return toolFromPi(pi, ownResults.get(pi.toolCallId));
      return undefined; // user (the sentinel) and system entries are not Kerby messages
    };

    for (;;) {
      const item = await queue.next();
      if (item.kind === "failed") throw item.error;
      if (item.kind === "settled") {
        // The stream is a view; the entries are the truth. Report any message it did not deliver.
        await stream.stop();
        stream = undefined;
        for await (const entry of entriesOf(root)) {
          const key = String(entry.id);
          if (emitted.has(key)) continue;
          const message = toKerby(entry);
          if (!message) continue;
          emitted.add(key);
          yield { type: "message_end", message };
        }
        if (item.status === "done") yield { type: "run_end", reason: "done" };
        else if (run.signal.aborted) yield { type: "run_end", reason: "aborted" };
        else {
          const outcome = classifyUnanswered(item.reason, item.detail);
          // Anything but a refusal is infrastructure: throw so the task retries from the persisted history.
          if (outcome.retryable) throw new Error(outcome.error);
          yield { type: "run_end", reason: "refused", error: outcome.error };
        }
        return;
      }

      const event = item.event;
      if (event.type === "message_start") {
        if (event.message.role === "assistant") {
          text.reset();
          yield { type: "message_start", role: "assistant" };
          for (const delta of text.fromBlocks(event.message.content))
            yield { type: "text_delta", text: delta };
        }
      } else if (event.type === "message_update") {
        for (const change of event.changes) {
          for (const delta of text.fromChange(change)) yield { type: "text_delta", text: delta };
        }
      } else if (event.type === "message_end") {
        const pi = event.entry.model?.[0];
        if (pi?.role === "assistant") {
          for (const delta of text.fromBlocks(pi.content))
            yield { type: "text_delta", text: delta };
        }
        const message = toKerby(event.entry);
        if (message && !emitted.has(String(event.entry.id))) {
          emitted.add(String(event.entry.id));
          yield { type: "message_end", message };
          // The supervisor pulled past this message, so it is persisted: its tools may run now.
          if (message.role === "assistant") {
            for (const part of message.content) if (part.type === "tool_call") gates.open(part.id);
          }
        }
      } else if (event.type === "tool_execution_start") {
        // A tool's own calls to other tools (nested) are its business, not the model's.
        if (event.parentToolCallId === undefined) {
          const call: ToolCall = {
            type: "tool_call",
            id: event.toolCallId,
            name: event.toolName,
            input: event.args,
          };
          calls.set(call.id, call);
          yield { type: "tool_start", call };
        }
      } else if (event.type === "tool_execution_end") {
        const call = calls.get(event.toolCallId);
        const pi = event.entry?.model?.[0];
        const result =
          ownResults.get(event.toolCallId) ??
          (pi?.role === "toolResult" ? toolResultFromPi(pi) : undefined);
        if (call && result) yield { type: "tool_end", call, result };
      }
    }
  } finally {
    run.signal.removeEventListener("abort", onAbort);
    gates.closeAll(new Error("run ended"));
    await stream?.stop().catch(() => {});
    await harness.close(context).catch(() => {});
  }
}

/** Every entry of the conversation, oldest first. */
async function* entriesOf(conversation: Conversation): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 100, cursor, context);
    yield* page.items;
    cursor = page.next;
  } while (cursor !== undefined);
}
