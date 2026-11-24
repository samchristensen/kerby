// `@kerby/sdk` against the real local stack (`make up` first; `make sdk-e2e`): every resource the SDK offers is called
// over HTTP against the real api, worker and dispatcher, so a drift between the SDK's contracts and the API fails here.
// The stack runs the scripted fake model (ARCHITECTURE.md#local-stack): "echo <text>" calls the echo tool, anything
// else answers "Echo: <text>", "[slow:<ms>]" delays the answer, "[think:<text>]" adds a reasoning block.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { startMcpFixture } from "@kerby/mcp/testing";
import {
  type EventEnvelope,
  isKerbyApiError,
  Kerby,
  KerbyApiError,
  KerbyTimeoutError,
  type PublicEvent,
  verifyWebhook,
  type WebhookEvent,
} from "@kerby/sdk";
import { stackApiKey } from "./stack.ts";

const BASE = `http://127.0.0.1:${process.env.KERBY_API_PORT ?? "8080"}`;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`sdk-e2e failed: ${message}`);
  console.log(`  ok: ${message}`);
}

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  seconds = 60,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`sdk-e2e failed: timed out waiting for ${what}`);
    await sleep(300);
  }
}

const apiKey = stackApiKey();
const kerby = new Kerby({ apiKey, baseUrl: BASE });

console.log("conversations");
const chat = await kerby.conversations.create({ externalUserId: "user-1", tools: ["kerby/echo"] });
check(
  chat.externalUserId === "user-1" && chat.tools.includes("kerby/echo"),
  "created a conversation",
);
const first = await kerby.conversations.ask(chat.id, "hello");
check(
  first.seq === 1 && first.text === "Echo: hello",
  "ask posted, waited and returned the answer",
);
check(
  first.messages.length === 1 && first.messages[0]?.seq === 2,
  "ask returned the turn's messages",
);
check(!(await kerby.conversations.status(chat.id)).busy, "status says idle after the answer");
const page = await kerby.conversations.get(chat.id);
check(
  page.messages.length === 2 && page.nextAfter === null && !page.busy,
  "get reads both messages",
);
const listed: string[] = [];
for await (const summary of kerby.conversations.listAll({ externalUserId: "user-1" }))
  listed.push(summary.id);
check(listed.includes(chat.id), "listAll finds it by externalUserId");

const events: EventEnvelope[] = [];
for await (const event of kerby.conversations.streamReply(chat.id, "echo hi [think:pondering]", {
  include: ["thinking"],
})) {
  events.push(event);
}
const types = events.map((event) => event.event.type);
check(types.at(-1) === "run_end", "streamReply ends at run_end");
check(
  types.includes("tool_start") && types.includes("tool_end"),
  "streamReply carries the tool events",
);
check(
  events.some(
    (event) => event.event.type === "thinking_end" || event.event.type === "thinking_delta",
  ),
  "include: thinking adds the reasoning events",
);
const final = events.findLast((event) => event.event.type === "message_end");
check(
  final?.event.type === "message_end" && final.event.message.role === "assistant",
  "the last message_end is the assistant's answer",
);
check(!(await kerby.conversations.status(chat.id)).busy, "idle after the streamed turn");

const slow = await kerby.conversations.post(chat.id, "slow [slow:3000]");
const busy = await kerby.conversations.post(chat.id, "again").catch((error: unknown) => error);
check(
  isKerbyApiError(busy, "conversation_busy"),
  "a second post during a turn is 409 conversation_busy",
);
await kerby.conversations.waitForTurn(chat.id);
check(slow.seq > 0, "waitForTurn waited for the slow turn");
const timedOut = await kerby.conversations
  .ask(chat.id, "slow again [slow:3000]", { timeoutMs: 500, pollMs: 100 })
  .catch((error: unknown) => error);
check(timedOut instanceof KerbyTimeoutError, "ask past timeoutMs throws KerbyTimeoutError");
await kerby.conversations.waitForTurn(chat.id);

const trace = [];
for await (const entry of kerby.conversations.traceAll(chat.id)) trace.push(entry);
check(
  trace.some((entry) => entry.event.type === "run_end"),
  "traceAll reads the trace",
);
const allMessages = [];
for await (const message of kerby.conversations.messages(chat.id)) allMessages.push(message);
check(
  allMessages.every((message, i) => message.seq === i + 1),
  "messages walks every message in order",
);

console.log("errors");
const missing = await kerby.conversations
  .get("00000000-0000-4000-8000-000000000000")
  .catch((e: unknown) => e);
check(
  missing instanceof KerbyApiError && missing.status === 404 && missing.code === "not_found",
  "unknown id: KerbyApiError 404 not_found",
);
const stranger = new Kerby({ apiKey: "kb_not_a_key", baseUrl: BASE });
const refused = await stranger.conversations.list().catch((e: unknown) => e);
check(isKerbyApiError(refused, "unauthorized"), "a wrong key is 401 unauthorized");

console.log("events");
const log = await until("the turn events", async () => {
  const result = await kerby.events.list({ conversationId: chat.id, types: ["turn.*"] });
  return result.events.some((event) => event.type === "turn.completed") && result;
});
check(
  log.events.some((event) => event.type === "turn.started"),
  "events.list filters by conversation and type",
);
const controller = new AbortController();
const tailed: PublicEvent[] = [];
const tailing = (async () => {
  for await (const received of kerby.events.tail({
    conversationId: chat.id,
    waitSeconds: 2,
    signal: controller.signal,
  })) {
    tailed.push(...received.events);
  }
})();
const live = await kerby.conversations.ask(chat.id, "tail me");
await until("the tail to see the new turn", async () =>
  tailed.some((event) => event.type === "turn.completed" && event.data.lastSeq > live.seq),
);
controller.abort();
await tailing;
check(tailed.length > 0, "events.tail followed new events and ended on abort");

console.log("search, tools, judgments");
const hits = await until("a search hit", async () => {
  const result = await kerby.search.query({ query: "hello" });
  return result.hits.length > 0 && result;
});
check(
  hits.mode === "keyword" && hits.hits.some((hit) => hit.conversationId === chat.id),
  "search finds the conversation",
);
check((await kerby.search.getSettings()).embeddingModel === null, "search settings read");
check(
  (await kerby.tools.list()).tools.some((tool) => tool.pattern === "kerby/echo"),
  "tools.list names kerby/echo",
);
const judged = await kerby.judgments
  .judge(
    {
      state: { text: "hi" },
      questions: { polite: { type: "noul", instructions: "Is it polite?" } },
    },
    { timeoutMs: 30_000 },
  )
  .catch((error: unknown) => error);
check(
  isKerbyApiError(judged, "invalid_model"),
  "a judgment without the provider's key is refused up front: 400 invalid_model",
);

console.log("prompts");
const name = `sdk/e2e-${Date.now().toString(36)}`;
const prompt = await kerby.prompts.create({
  name,
  kind: "chat",
  draft: {
    kind: "chat",
    text: "You greet {{who}}.",
    variables: [{ name: "who", default: "everyone" }],
  },
});
const published = await kerby.prompts.publish(name, {
  revision: prompt.draftRevision,
  note: "first",
});
await kerby.prompts.setLabel(name, "production", published.version);
const rendered = await kerby.prompts.render(name, "production", { who: "SDK" });
check(
  rendered.text === "You greet SDK.",
  "a prompt with a slash in its name publishes, labels and renders",
);
const fromPrompt = await kerby.conversations.create({
  prompt: { name, version: "production", variables: { who: "Ada" } },
});
check(
  fromPrompt.system === "You greet Ada." && fromPrompt.prompt?.name === name,
  "a conversation starts from the labelled prompt",
);
check(
  (await kerby.prompts.list({ kind: "chat" })).some((p) => p.name === name),
  "prompts.list finds it",
);
const conflict = await kerby.prompts
  .saveDraft(name, { revision: 99, draft: prompt.draft })
  .catch((e: unknown) => e);
check(isKerbyApiError(conflict, "draft_conflict"), "a stale draft revision is 409 draft_conflict");

console.log("subscriptions and webhooks");
const received: Promise<WebhookEvent>[] = [];
const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    received.push(
      secretRef.current
        ? verifyWebhook({ secret: secretRef.current, body, headers: request.headers })
        : Promise.reject(new Error("no secret yet")),
    );
    response.writeHead(200).end();
  });
});
const secretRef: { current: string | undefined } = { current: undefined };
await new Promise<void>((resolve) => receiver.listen(0, "0.0.0.0", resolve));
const receiverPort = (receiver.address() as AddressInfo).port;
const created = await kerby.subscriptions.create({
  destination: { kind: "webhook", url: `http://host.docker.internal:${receiverPort}/hook` },
  types: ["turn.completed"],
});
secretRef.current = created.secret;
check(created.secret.startsWith("whsec_"), "subscription created; secret shown once");
await kerby.subscriptions.sendTestPing(created.subscription.id);
const ping = await until("the ping", async () => received.length > 0 && (await received[0]));
check(ping.type === "ping", "a webhook arrived and verifyWebhook accepted its signature");
const turn = await kerby.conversations.ask(chat.id, "webhook me");
const delivered = await until("the turn.completed webhook", async () => {
  for (const pending of received) {
    const event = await pending;
    if (event.type === "turn.completed" && event.data.lastSeq > turn.seq) return event;
  }
  return undefined;
});
check(delivered.type === "turn.completed", "turn.completed was pushed, thin, and verified");
const attempts = [];
for await (const attempt of kerby.subscriptions.listAllDeliveries(created.subscription.id))
  attempts.push(attempt);
check(
  attempts.some((attempt) => attempt.outcome === "delivered"),
  "the delivery log lists the delivered attempts",
);
const rotated = await kerby.subscriptions.rotateSecret(created.subscription.id);
check(rotated.secret !== created.secret, "the secret rotates");
await kerby.subscriptions.delete(created.subscription.id);
receiver.close();

console.log("admin: model keys, tool servers, integrations");
await kerby.modelKeys.put("anthropic", "sk-test-sdk-e2e-0000");
check(
  (await kerby.modelKeys.list()).keys.some((key) => key.provider === "anthropic"),
  "a model key is stored and listed, never returned",
);
await kerby.modelKeys.delete("anthropic");
check(
  !(await kerby.modelKeys.list()).keys.some((key) => key.provider === "anthropic"),
  "and deleted",
);
check(Array.isArray((await kerby.toolServers.list()).servers), "toolServers.list");
const integrations = (await kerby.integrations.list()).integrations;
const defaultIntegration = integrations.find((integration) => integration.name === "default");
check(defaultIntegration !== undefined, "integrations.list finds the default integration");
await kerby.integrations.getToolGrants(defaultIntegration.id);

console.log("tool servers");
await using fixture = await startMcpFixture({
  mode: "stateless",
  urlHost: "host.docker.internal",
  tools: [
    {
      name: "lookup",
      description: "Find a customer by name.",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      handler: (args) => ({
        content: [{ type: "text", text: `customer ${String(args.q)}: Paris` }],
      }),
    },
  ],
});
const crm = await kerby.toolServers.create({ slug: "crm", url: fixture.url });
check(crm.slug === "crm", "a tool server is registered");
const synced = await until("the worker to list the server's tools", async () => {
  const server = await kerby.toolServers.get("crm");
  return server.status !== "syncing" && server;
});
check(
  synced.status === "ready" && synced.tools.some((tool) => tool.name === "lookup" && !tool.enabled),
  "its tools are listed, disabled until an admin enables them",
);
const lookup = synced.tools.find((tool) => tool.name === "lookup");
await kerby.toolServers.updateTool("crm", "lookup", {
  enabled: true,
  effect: "read",
  expectedDefinition: lookup?.listedHash ?? "",
});
const toolChat = await kerby.conversations.create({ tools: ["crm/lookup"] });
const called = await kerby.conversations.ask(toolChat.id, 'call crm__lookup {"q":"ada"}');
check(
  called.text.includes("customer ada: Paris"),
  "a conversation calls the tool through the worker and the answer carries its result",
);
const unknown = await kerby.conversations
  .create({ tools: ["crm/nope"] })
  .catch((error: unknown) => error);
check(
  isKerbyApiError(unknown, "unknown_tool") && Array.isArray(unknown.problems),
  "an unknown tool is 400 unknown_tool with per-pattern problems",
);
await kerby.toolServers.delete("crm");

console.log("sdk-e2e passed");
