import { setTimeout as sleep } from "node:timers/promises";
import type { AgentEvent, AgentMessage, AgentRuntime } from "@kerby/agent";
import { createTestBlobs } from "@kerby/blobs/testing";
import { createApiKey, insertTenant, setTenantStatus } from "@kerby/control-plane";
import { createTestControlDb } from "@kerby/control-plane/testing";
import {
  conversationChannel,
  insertConversation,
  isBusy,
  parseNotice,
  postUserMessage,
  readMessages,
} from "@kerby/conversations";
import { createTestTenant } from "@kerby/conversations/testing";
import { type TenantDb, TenantPools } from "@kerby/db";
import { afterEach, describe, expect, it } from "vitest";
import { workerConfigSchema } from "./config/index.ts";
import {
  createDevelopmentRuntime,
  createHandlers,
  createScheduler,
  type WorkerDeps,
} from "./index.ts";

const cleanups: (() => PromiseLike<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function eventually<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Options = {
  runtime?: AgentRuntime;
  maxConcurrent?: number;
  echo?: boolean;
  settings?: Partial<WorkerDeps["settings"]>;
  modelKeys?: WorkerDeps["modelKeys"];
};

async function harness(options: Options = {}) {
  const control = await createTestControlDb();
  cleanups.push(() => control[Symbol.asyncDispose]());
  const blobs = await createTestBlobs();
  const urls = new Map<string, string>();
  const pools = new TenantPools({
    resolveUrl: async (id) => urls.get(id) ?? Promise.reject(new Error(`unknown tenant ${id}`)),
  });
  cleanups.push(() => pools.close());
  const runtime = options.runtime ?? createDevelopmentRuntime();
  const deps: WorkerDeps = {
    control: control.db,
    pools,
    blobs,
    runtime,
    modelKeys: options.modelKeys,
    settings: {
      workerId: "test-worker",
      claimTimeoutSeconds: 30,
      defaultMaxConcurrentTurns: options.maxConcurrent ?? 4,
      sweepIntervalMs: 200,
      enableEchoTool: options.echo ?? true,
      ...options.settings,
    },
  };
  const scheduler = createScheduler(deps, createHandlers(deps));
  await scheduler.start();
  cleanups.push(() => scheduler.stop(0));

  async function tenant(name: string, limits: Record<string, unknown> = {}) {
    const row = await insertTenant(control.db, { name, dbHost: "h", dbPort: 1, limits });
    await setTenantStatus(control.db, row.id, "active");
    await createApiKey(control.db, row.id);
    const database = await createTestTenant();
    cleanups.push(() => database[Symbol.asyncDispose]());
    urls.set(row.id, database.url);
    return { id: row.id, ctx: { tenantId: row.id, db: database.db } };
  }

  /** Post a user message the way the API does, optionally without the notification (the sweep must find it). */
  async function post(
    t: Awaited<ReturnType<typeof tenant>>,
    conversationId: string,
    text: string,
    notify = true,
  ) {
    const posted = await postUserMessage(t.ctx, blobs, conversationId, [{ type: "text", text }]);
    if (notify) await control.db.query("select pg_notify('tenant_work', $1)", [t.id]);
    return posted.seq;
  }

  async function conversation(t: Awaited<ReturnType<typeof tenant>>) {
    return insertConversation(t.ctx.db, { model: "fake/fake-1", system: "Be brief." });
  }

  const messages = async (t: Awaited<ReturnType<typeof tenant>>, conversationId: string) =>
    (await readMessages(t.ctx, blobs, conversationId)).map((m) => m.message);

  const settled = (t: Awaited<ReturnType<typeof tenant>>, conversationId: string, count: number) =>
    eventually(`${count} messages in ${conversationId}`, async () => {
      if (await isBusy(t.ctx.db, conversationId)) return false;
      const all = await messages(t, conversationId);
      return all.length >= count ? all : false;
    });

  /** A second worker process over the same databases, with its own runtime and settings. */
  async function extraWorker(extra: {
    runtime: AgentRuntime;
    settings?: Partial<WorkerDeps["settings"]>;
  }) {
    const second: WorkerDeps = {
      ...deps,
      runtime: extra.runtime,
      settings: { ...deps.settings, ...extra.settings, workerId: "second-worker" },
    };
    const other = createScheduler(second, createHandlers(second));
    await other.start();
    cleanups.push(() => other.stop(0));
    return other;
  }

  return {
    control,
    blobs,
    deps,
    scheduler,
    tenant,
    post,
    conversation,
    messages,
    settled,
    extraWorker,
  };
}

const textOf = (message: AgentMessage | undefined): string =>
  message ? message.content.map((part) => ("text" in part ? part.text : "")).join("") : "";

describe("a turn", () => {
  it("answers a message, records usage, and streams live events", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    const notices: string[] = [];
    const subscription = await t.ctx.db.listen(conversationChannel(conversation.id), (p) =>
      notices.push(p),
    );
    cleanups.push(() => subscription.close());

    await h.post(t, conversation.id, "hello");
    const all = await h.settled(t, conversation.id, 2);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(all[1])).toBe("Echo: hello");

    const usage = await h.control.db.query(
      "select dedupe_key, model from usage where tenant_id = $1",
      [t.id],
    );
    expect(usage.rows).toEqual([{ dedupe_key: `${conversation.id}:2`, model: "fake/fake-1" }]);

    await eventually("run_end notice", async () =>
      notices.map(parseNotice).some((n) => n && "live" in n && n.live.event.type === "run_end"),
    );
    const types = notices
      .map(parseNotice)
      .map((n) =>
        n && "live" in n
          ? n.live.event.type
          : n && "persisted" in n
            ? `persisted:${n.persisted}`
            : "?",
      );
    expect(types).toContain("run_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("persisted:2");
    expect(types.indexOf("persisted:2")).toBeGreaterThan(types.indexOf("run_start"));
  });

  it("finds work by its sweep when no notification arrives", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "quiet", false);
    expect((await h.settled(t, conversation.id, 2)).length).toBe(2);
  });

  it("runs a tool once, after the message that asked for it was stored", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "echo ping");
    const all = await h.settled(t, conversation.id, 4);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(textOf(all[3])).toBe("Tool said: ping");

    const executions = await t.ctx.db.query<{ executions: number; first_at: Date }>(
      "select executions, first_at from tool_executions",
    );
    expect(executions.rows.map((r) => r.executions)).toEqual([1]);
    const requested = await t.ctx.db.query<{ created_at: Date }>(
      "select created_at from messages where seq = 2",
    );
    expect((executions.rows[0]?.first_at ?? new Date(0)).getTime()).toBeGreaterThanOrEqual(
      requested.rows[0]?.created_at.getTime() ?? Infinity,
    );
  });
});

/** A runtime that behaves like the real one but throws once, right after the tool result was persisted. */
function crashingOnce(inner: AgentRuntime): AgentRuntime {
  let crashed = false;
  return {
    name: "crashing",
    async *run(run) {
      for await (const event of inner.run(run)) {
        yield event;
        if (!crashed && event.type === "message_end" && event.message.role === "tool") {
          crashed = true;
          throw new Error("worker died here");
        }
      }
    },
  };
}

/** Make a queued turn retry at once instead of after Absurd's backoff, with `maxAttempts`. */
async function retryFast(
  t: { ctx: { db: { query(sql: string): Promise<unknown> } } },
  maxAttempts = 5,
) {
  await t.ctx.db.query(
    `update absurd.t_turns set retry_strategy = '{"kind":"fixed","base_seconds":0}'::jsonb, max_attempts = ${maxAttempts}`,
  );
}

describe("recovery", () => {
  it("a turn that dies after its tool ran finishes on retry without running the tool again", async () => {
    const real = createDevelopmentRuntime();
    const h = await harness({ runtime: crashingOnce(real) });
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "echo ping", false);
    await retryFast(t);
    await h.control.db.query("select pg_notify('tenant_work', $1)", [t.id]);

    const all = await h.settled(t, conversation.id, 4);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(textOf(all[3])).toBe("Tool said: ping");
    const executions = await t.ctx.db.query<{ executions: number }>(
      "select executions from tool_executions",
    );
    expect(executions.rows).toEqual([{ executions: 1 }]);
    const attempts = await t.ctx.db.query<{ attempts: number }>(
      "select attempts from absurd.t_turns",
    );
    expect(attempts.rows).toEqual([{ attempts: 2 }]);
    // each message exactly once, in order
    const seqs = await t.ctx.db.query<{ seq: number }>("select seq from messages order by seq");
    expect(seqs.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("records why a turn failed for good, and is not busy afterwards", async () => {
    const failing: AgentRuntime = {
      name: "failing",
      // biome-ignore lint/correctness/useYield: it fails before producing anything
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error("provider is down");
      },
    };
    const h = await harness({ runtime: failing });
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "hello", false);
    await retryFast(t, 2);
    await h.control.db.query("select pg_notify('tenant_work', $1)", [t.id]);

    await eventually("the turn to fail", async () => {
      const { rows } = await t.ctx.db.query<{ last_error: string | null }>(
        "select last_error from conversations",
      );
      return rows[0]?.last_error;
    });
    expect(
      (await t.ctx.db.query<{ last_error: string }>("select last_error from conversations")).rows[0]
        ?.last_error,
    ).toBe("the turn failed after 2 attempts");
    expect(await isBusy(t.ctx.db, conversation.id)).toBe(false);
    expect(await h.messages(t, conversation.id)).toHaveLength(1);
  });

  it("a refused request ends the turn with the reason on the conversation, without retrying", async () => {
    const refusing: AgentRuntime = {
      name: "refusing",
      async *run() {
        yield { type: "run_start" };
        yield { type: "run_end", reason: "refused", error: "model_error: 400 bad tool schema" };
      },
    };
    const h = await harness({ runtime: refusing });
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "hello");
    await eventually("last_error", async () => {
      const { rows } = await t.ctx.db.query<{ last_error: string | null }>(
        "select last_error from conversations",
      );
      return rows[0]?.last_error;
    });
    await eventually("turn done", async () => !(await isBusy(t.ctx.db, conversation.id)));
    expect((await t.ctx.db.query("select attempts from absurd.t_turns")).rows).toEqual([
      { attempts: 1 },
    ]);
    // a new message clears the error
    await h.post(t, conversation.id, "again");
    expect(
      (await t.ctx.db.query<{ last_error: string | null }>("select last_error from conversations"))
        .rows[0]?.last_error,
    ).toBeNull();
  });
});

describe("bring your own key", () => {
  const lastError = async (t: { ctx: { db: TenantDb } }) =>
    (await t.ctx.db.query<{ last_error: string | null }>("select last_error from conversations"))
      .rows[0]?.last_error;

  it("hands the run the tenant's own key, looked up by tenant and provider", async () => {
    const seen: { apiKey: string | undefined; model: string }[] = [];
    const runtime: AgentRuntime = {
      name: "spy",
      async *run(run) {
        seen.push({ apiKey: run.apiKey, model: run.model });
        yield { type: "run_start" };
        yield { type: "run_end", reason: "done" };
      },
    };
    const lookups: string[] = [];
    const h = await harness({
      runtime,
      modelKeys: async (tenantId, provider) => {
        lookups.push(`${tenantId}:${provider}`);
        return `key-for-${provider}`;
      },
    });
    const t = await h.tenant("acme");
    const conversation = await insertConversation(t.ctx.db, {
      model: "acme-ai/big-1",
      system: "s",
    });
    await h.post(t, conversation.id, "hello");
    await eventually("turn", async () => seen.length > 0);
    expect(seen).toEqual([{ apiKey: "key-for-acme-ai", model: "acme-ai/big-1" }]);
    expect(lookups).toEqual([`${t.id}:acme-ai`]);
  });

  it("refuses a turn when the tenant has no key, without running the harness or retrying", async () => {
    let ran = false;
    const runtime: AgentRuntime = {
      name: "spy",
      async *run() {
        ran = true;
        yield { type: "run_end", reason: "done" };
      },
    };
    const h = await harness({ runtime, modelKeys: async () => undefined });
    const t = await h.tenant("acme");
    const conversation = await insertConversation(t.ctx.db, { model: "anthropic/x", system: "s" });
    await h.post(t, conversation.id, "hello");
    await eventually("last_error", () => lastError(t).then((e) => e ?? false));
    await eventually("turn done", async () => !(await isBusy(t.ctx.db, conversation.id)));
    expect(await lastError(t)).toMatch(/no model key for provider "anthropic"/);
    expect(ran).toBe(false);
    expect((await t.ctx.db.query("select attempts from absurd.t_turns")).rows).toEqual([
      { attempts: 1 },
    ]);
  });

  it("never lets the key reach the conversation, the live stream, or a thrown error", async () => {
    const secret = "sk-live-0123456789abcdef";
    const runtime: AgentRuntime = {
      name: "leaky",
      async *run() {
        yield { type: "run_start" };
        yield { type: "run_end", reason: "refused", error: `401 invalid key ${secret}` };
      },
    };
    const h = await harness({ runtime, modelKeys: async () => secret });
    const t = await h.tenant("acme");
    const conversation = await insertConversation(t.ctx.db, { model: "anthropic/x", system: "s" });
    const notices: string[] = [];
    const subscription = await t.ctx.db.listen(conversationChannel(conversation.id), (p) =>
      notices.push(p),
    );
    cleanups.push(() => subscription.close());
    await h.post(t, conversation.id, "hello");
    const stored = await eventually("last_error", () => lastError(t).then((e) => e ?? false));
    expect(stored).toBe("401 invalid key [redacted]");
    await eventually("run_end notice", async () => notices.some((n) => n.includes('"run_end"')));
    expect(notices.join("\n")).not.toContain(secret);
  });

  it("keeps the key out of the failure Absurd records when the harness throws it", async () => {
    const secret = "sk-live-0123456789abcdef";
    const failing: AgentRuntime = {
      name: "leaky",
      // biome-ignore lint/correctness/useYield: it fails before producing anything
      async *run(): AsyncGenerator<AgentEvent> {
        throw new Error(`connect failed for key ${secret}`);
      },
    };
    const h = await harness({ runtime: failing, modelKeys: async () => secret });
    const t = await h.tenant("acme");
    const conversation = await insertConversation(t.ctx.db, { model: "anthropic/x", system: "s" });
    await h.post(t, conversation.id, "hello", false);
    await retryFast(t, 2);
    await h.control.db.query("select pg_notify('tenant_work', $1)", [t.id]);
    await eventually("the turn to fail", () => lastError(t).then((e) => e ?? false));
    const runs = await t.ctx.db.query("select to_jsonb(r)::text as row from absurd.r_turns r");
    expect(runs.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(runs.rows)).toContain("[redacted]");
    expect(JSON.stringify(runs.rows)).not.toContain(secret);
  });
});

describe("fencing", () => {
  it("a worker whose lease lapsed cannot write a divergent message after another worker took over", async () => {
    const release = Promise.withResolvers<void>();
    const reachedGate = Promise.withResolvers<void>();
    // The first worker: blocked in the model call past its lease, then it answers differently.
    const stale: AgentRuntime = {
      name: "stale",
      async *run(run) {
        yield { type: "run_start" };
        reachedGate.resolve();
        await release.promise;
        void run;
        yield {
          type: "message_end",
          message: {
            role: "assistant",
            model: "fake/fake-1",
            stopReason: "end",
            content: [{ type: "text", text: "DIVERGENT" }],
          },
        };
        yield { type: "run_end", reason: "done" };
      },
    };
    // It never heartbeats and its lease is one second: it lapses while it waits.
    const h = await harness({
      runtime: stale,
      settings: { claimTimeoutSeconds: 1, heartbeatEveryMs: 600_000 },
    });
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await h.post(t, conversation.id, "hello", false);
    await t.ctx.db.query(
      `update absurd.t_turns set retry_strategy = '{"kind":"fixed","base_seconds":0}'::jsonb`,
    );
    await h.control.db.query("select pg_notify('tenant_work', $1)", [t.id]);
    await reachedGate.promise;

    // The second worker takes the turn over once the first lease lapses, and is held up before it answers.
    const releaseSecond = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    const real = createDevelopmentRuntime();
    const second: AgentRuntime = {
      name: "second",
      async *run(run) {
        secondStarted.resolve();
        await releaseSecond.promise;
        yield* real.run(run);
      },
    };
    await h.extraWorker({ runtime: second, settings: { claimTimeoutSeconds: 30 } });
    await secondStarted.promise;

    // The first worker wakes up while the second owns the turn and tries to persist its own answer: refused, so
    // nothing lands at position 2 even though the second has not written there yet.
    release.resolve();
    await eventually("the stale worker to give up", async () => h.scheduler.inFlight(t.id) === 0);
    expect((await t.ctx.db.query("select 1 from messages")).rowCount).toBe(1);

    releaseSecond.resolve();
    const answered = await h.settled(t, conversation.id, 2);
    expect(textOf(answered[1])).toBe("Echo: hello");
    const after = await h.messages(t, conversation.id);
    expect(after.map(textOf)).toEqual(["hello", "Echo: hello"]);
    // Nothing the stale run wrote is reachable: its object, if it got that far, is not what the index points at.
    const stored = await h.blobs.get(
      t.ctx,
      (await t.ctx.db.query<{ blob_id: string }>("select blob_id from messages where seq = 2"))
        .rows[0]?.blob_id ?? "",
    );
    expect(new TextDecoder().decode(stored.body)).not.toContain("DIVERGENT");
  });
});

describe("scheduling", () => {
  it("does not claim for a suspended tenant until it is resumed", async () => {
    const h = await harness();
    const t = await h.tenant("acme");
    const conversation = await h.conversation(t);
    await setTenantStatus(h.control.db, t.id, "suspended");
    await h.post(t, conversation.id, "hello");
    await sleep(800);
    expect(await h.messages(t, conversation.id)).toHaveLength(1);
    await setTenantStatus(h.control.db, t.id, "active");
    expect((await h.settled(t, conversation.id, 2)).length).toBe(2);
  });

  it("keeps a tenant under its concurrency limit, and a tenant at its limit does not delay another", async () => {
    const h = await harness();
    const noisy = await h.tenant("noisy", { maxConcurrentTurns: 1 });
    const quiet = await h.tenant("quiet");
    const noisyConversations = await Promise.all([1, 2, 3].map(() => h.conversation(noisy)));
    for (const c of noisyConversations) await h.post(noisy, c.id, "[slow:700] work");

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, h.scheduler.inFlight(noisy.id));
    }, 20);
    cleanups.push(() => clearInterval(sampler));

    await eventually(
      "the noisy tenant's first turn to start",
      async () => h.scheduler.inFlight(noisy.id) === 1,
    );
    const started = Date.now();
    const calm = await h.conversation(quiet);
    await h.post(quiet, calm.id, "hi");
    await h.settled(quiet, calm.id, 2);
    const quietLatency = Date.now() - started;

    // The quiet tenant finished while the noisy tenant still had turns queued behind its limit.
    const unfinished = await Promise.all(
      noisyConversations.map(async (c) => (await h.messages(noisy, c.id)).length < 2),
    );
    expect(unfinished.some(Boolean)).toBe(true);
    expect(quietLatency).toBeLessThan(2000);

    for (const c of noisyConversations) await h.settled(noisy, c.id, 2);
    expect(peak).toBe(1);
  });
});

describe("worker config", () => {
  const base = {
    controlDatabaseUrl: "postgres://x",
    tenantDbSecret: "0123456789abcdef",
    s3Endpoint: "http://localhost:9000",
    s3Bucket: "b",
    s3AccessKeyId: "k",
    s3SecretAccessKey: "s",
  };
  it("refuses the fake model in production and allows it in development", () => {
    const refused = workerConfigSchema.safeParse({ ...base, kerbyFakeModel: "1" });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toContain("KERBY_ENVIRONMENT=development");
    expect(
      workerConfigSchema.safeParse({
        ...base,
        kerbyFakeModel: "1",
        kerbyEnvironment: "development",
      }).success,
    ).toBe(true);
    expect(workerConfigSchema.parse({ ...base, secretsPrivateKeys: "a2V5" }).kerbyFakeModel).toBe(
      false,
    );
  });

  it("requires a secrets private key unless it runs the fake model", () => {
    const refused = workerConfigSchema.safeParse(base);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(["secretsPrivateKeys"]);
  });
});
