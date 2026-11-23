// End to end against the real Compose stack (plan 0002, T12): two workers, the scripted fake model, a conversation
// streamed over SSE, then `docker kill` of the worker that holds the turn while it is waiting for the model after a
// tool ran. The turn must finish on the other worker, the tool must have run exactly once, and the transcript must
// have every message exactly once, in order. Run with `make e2e`.
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = `http://127.0.0.1:${process.env.KERBY_API_PORT ?? "8080"}`;
const KEEP = process.env.KERBY_E2E_KEEP === "1";

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const compose = (...args: string[]) => run("docker", ["compose", ...args]);
const psql = (database: string, sql: string) =>
  compose("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database, "-tAc", sql);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`e2e failed: ${message}`);
  console.log(`  ok: ${message}`);
}

async function until<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  seconds = 90,
): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`e2e failed: timed out waiting for ${what}`);
    await sleep(500);
  }
}

async function main(): Promise<void> {
  console.log("bringing the stack up with two workers");
  compose("up", "-d", "--build", "--wait", "--scale", "worker=2");
  const key = run("./scripts/provision-default.sh", []);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  // Tools are never implied (ADR 0019): the conversation names the built-in echo the fake model asks for.
  const created = await call("POST", "/v1/conversations", { tools: ["kerby/echo"] });
  check(created.status === 201, "created a conversation that names kerby/echo");
  check(
    JSON.stringify(created.body.tools) === JSON.stringify(["kerby/echo"]),
    "the conversation lists its tools",
  );
  const conversationId = String(created.body.id);

  // Stream the conversation's events the whole time, as a client would.
  const seen: { id: string | null; type: string }[] = [];
  const stream = new AbortController();
  const streaming = (async () => {
    const response = await fetch(`${BASE}/v1/conversations/${conversationId}/events`, {
      headers: { authorization: `Bearer ${key}` },
      signal: stream.signal,
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        if (type) seen.push({ id: /^id: (.+)$/m.exec(block)?.[1] ?? null, type });
      }
    }
  })().catch(() => {});

  const message = "echo survive [slow-after-tool:12000]";
  const posted = await call("POST", `/v1/conversations/${conversationId}/messages`, {
    content: message,
  });
  check(
    posted.status === 202,
    "posted a message that asks for the echo tool, then a 12 s wait for the model",
  );

  const database = psql(
    "kerby_control",
    "select db_name from tenants where name = 'default' and status = 'active'",
  );
  const toolRan = await until(
    "the tool to run",
    () => psql(database, "select executions from tool_executions") === "1",
  );
  check(toolRan, "the tool ran once");

  // Who holds the turn? Absurd records the claiming worker as `<hostname>:<pid>`; a container's hostname is its id.
  const holder = await until(
    "a worker to hold the turn",
    () =>
      psql(database, "select claimed_by from absurd.r_turns where state = 'running' limit 1") ||
      undefined,
  );
  const workers = compose("ps", "-q", "worker").split("\n");
  const victim = workers.find((id) => holder.startsWith(id.slice(0, 12)));
  check(victim, `found the worker container holding the turn (${holder})`);
  run("docker", ["kill", victim]);
  console.log(`killed ${victim.slice(0, 12)} mid-turn`);

  const done = await until(
    "the turn to finish on the other worker",
    async () => {
      const view = await call("GET", `/v1/conversations/${conversationId}`);
      const messages = view.body.messages as {
        seq: number;
        message: { role: string; content: { text?: string }[] };
      }[];
      return view.body.busy === false && messages.length >= 4 ? messages : undefined;
    },
    120,
  );

  check(
    done.map((m) => m.message.role).join(",") === "user,assistant,tool,assistant",
    "the transcript is user, assistant, tool, assistant",
  );
  check(done.map((m) => m.seq).join(",") === "1,2,3,4", "every message exactly once, in order");
  check(
    done[3]?.message.content[0]?.text?.startsWith("Tool said: survive") === true,
    "the final answer reflects the tool result",
  );
  check(
    psql(database, "select executions from tool_executions") === "1",
    "the tool still ran exactly once",
  );
  check(
    Number(psql(database, "select attempts from absurd.t_turns")) >= 2,
    "the turn was retried after the kill",
  );
  check(psql(database, "select count(*) from messages") === "4", "the index holds four messages");
  await sleep(500);
  check(
    seen.some((e) => e.id === "4" && e.type === "message_end"),
    "the open SSE stream delivered the final message after the kill",
  );
  const ids = seen.filter((e) => e.id !== null).map((e) => Number(e.id));
  check(
    ids.every((id, i) => i === 0 || id > (ids[i - 1] ?? 0)),
    "persisted events arrived in order, without repeats",
  );

  stream.abort();
  await streaming;
  console.log("e2e passed");
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
  console.error(compose("logs", "--tail", "40", "worker", "api", "control"));
} finally {
  if (!KEEP) compose("down", "--volumes", "--remove-orphans", "--rmi", "local");
}
process.exit(failed ? 1 : 0);
