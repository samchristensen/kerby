import { setTimeout as sleep } from "node:timers/promises";
import { type ClosableTenantDb, createTenantDb } from "@kerby/db";
import { createMigratedDatabase } from "@kerby/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  createTenantExecutor,
  durableMigrationsDir,
  holdsRun,
  readTask,
  spawnInTx,
  type TaskHandlers,
} from "./index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function tenant(): Promise<ClosableTenantDb> {
  const database = await createMigratedDatabase([durableMigrationsDir]);
  const db = createTenantDb(database.url, { max: 5 });
  cleanups.push(async () => {
    await db.close();
    await database.drop();
  });
  return db;
}

const turn = { conversationId: "c1", seq: 1 };
const spawn = (
  db: ClosableTenantDb,
  key: string,
  retry?: Parameters<typeof spawnInTx>[3]["retry"],
) =>
  db.transaction((tx) =>
    spawnInTx(tx, "run-turn", turn, { idempotencyKey: key, ...(retry ? { retry } : {}) }),
  );

describe("spawnInTx", () => {
  it("creates the task only if the surrounding transaction commits", async () => {
    const db = await tenant();
    await db.query("create table rows (v int)");
    await expect(
      db.transaction(async (tx) => {
        await tx.query("insert into rows values (1)");
        await spawnInTx(tx, "run-turn", turn, { idempotencyKey: "k" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await db.query("select 1 from absurd.t_turns")).rowCount).toBe(0);
    expect((await db.query("select 1 from rows")).rowCount).toBe(0);

    await db.transaction(async (tx) => {
      await tx.query("insert into rows values (1)");
      await spawnInTx(tx, "run-turn", turn, { idempotencyKey: "k" });
    });
    expect((await db.query("select 1 from absurd.t_turns")).rowCount).toBe(1);
  });

  it("returns the existing task for a repeated idempotency key", async () => {
    const db = await tenant();
    const first = await spawn(db, "turn:c1:1");
    const again = await spawn(db, "turn:c1:1");
    const other = await spawn(db, "turn:c1:2");
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    expect(other.taskId).not.toBe(first.taskId);
    expect((await db.query("select 1 from absurd.t_turns")).rowCount).toBe(2);
  });
});

describe("readTask", () => {
  const request = {
    model: "typesafe/jev-latest",
    state: "I was charged twice.",
    questions: { billing: { type: "noul", instructions: "Is this about billing?" } },
  } as const;
  const outcome = {
    type: "answered",
    model: "jev",
    answers: { billing: { type: "noul", probability: 0.9 } },
    usage: { inputTokens: 1, outputTokens: 1 },
  } as const;

  it("shows a task pending, then completed with what its handler returned", async () => {
    const db = await tenant();
    const { taskId } = await db.transaction((tx) =>
      spawnInTx(tx, "run-judgment", request, { idempotencyKey: "j1" }),
    );
    const pending = await readTask(db, "run-judgment", taskId);
    expect(pending).toMatchObject({ id: taskId, state: "pending", params: request, result: null });
    expect(pending?.createdAt).toBeInstanceOf(Date);

    const executor = createTenantExecutor(
      db,
      { "run-judgment": async () => outcome },
      { workerId: "w" },
    );
    const [claimed] = await executor.claim(1);
    await executor.execute(claimed as NonNullable<typeof claimed>);
    const done = await readTask(db, "run-judgment", taskId);
    expect(done).toMatchObject({ state: "completed", result: outcome });
    expect(done?.createdAt).toEqual(pending?.createdAt);
  });

  it("does not find a task of another name, or an id that is not one", async () => {
    const db = await tenant();
    const { taskId } = await spawn(db, "turn");
    expect(await readTask(db, "run-judgment", taskId)).toBeUndefined();
    expect(await readTask(db, "run-turn", taskId)).toMatchObject({ state: "pending" });
    expect(await readTask(db, "run-judgment", crypto.randomUUID())).toBeUndefined();
  });
});

describe("TenantExecutor", () => {
  it("runs a claimed task with its params and completes it", async () => {
    const db = await tenant();
    const seen: unknown[] = [];
    const handlers: Partial<TaskHandlers> = {
      "run-turn": async (params, run) => {
        seen.push(params);
        await run.step("once", async () => 1);
      },
    };
    const executor = createTenantExecutor(db, handlers, { workerId: "w1" });
    const { taskId } = await spawn(db, "k");
    const claimed = await executor.claim(5);
    expect(claimed).toHaveLength(1);
    await executor.execute(claimed[0] as (typeof claimed)[number]);
    expect(seen).toEqual([turn]);
    const { rows } = await db.query<{ state: string }>(
      "select state from absurd.t_turns where task_id = $1",
      [taskId],
    );
    expect(rows[0]?.state).toBe("completed");
    expect(await executor.claim(5)).toEqual([]);
  });

  it("heartbeats for the whole run, so a long run is never claimed twice", async () => {
    const db = await tenant();
    const handlers: Partial<TaskHandlers> = {
      "run-turn": async () => {
        await sleep(4500); // more than two lease lengths, with no step in between
      },
    };
    const a = createTenantExecutor(db, handlers, { workerId: "a", claimTimeoutSeconds: 2 });
    const b = createTenantExecutor(db, handlers, { workerId: "b", claimTimeoutSeconds: 2 });
    const { taskId } = await spawn(db, "k", { kind: "fixed", baseSeconds: 0 });
    const [task] = await a.claim(1);
    const running = a.execute(task as NonNullable<typeof task>);
    let stolen = 0;
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      stolen += (await b.claim(5)).length; // a limit with room: only the lease keeps b out
    }
    await running;
    expect(stolen).toBe(0);
    const { rows } = await db.query<{ attempts: number; state: string }>(
      "select attempts, state from absurd.t_turns where task_id = $1",
      [taskId],
    );
    expect(rows[0]).toEqual({ attempts: 1, state: "completed" });
  });

  it("claims within the tenant's limit counted across workers, and concurrent claims never overshoot it", async () => {
    const db = await tenant();
    const handlers: Partial<TaskHandlers> = { "run-turn": async () => {} };
    const executors = ["a", "b", "c", "d"].map((workerId) =>
      createTenantExecutor(db, handlers, { workerId }),
    );
    for (let i = 0; i < 6; i++) await spawn(db, `k${i}`);
    const claimed = (await Promise.all(executors.map((e) => e.claim(3)))).flat();
    expect(claimed).toHaveLength(3);
    expect(await executors[0]?.claim(3)).toEqual([]);
    // A finished run frees its slot for any worker.
    await executors[0]?.execute(claimed[0] as NonNullable<(typeof claimed)[number]>);
    expect(await executors[1]?.claim(3)).toHaveLength(1);
  });

  it("claims no more than the caller can run, and leaves the rest queued", async () => {
    const db = await tenant();
    const executor = createTenantExecutor(db, { "run-turn": async () => {} }, { workerId: "a" });
    for (let i = 0; i < 4; i++) await spawn(db, `k${i}`);
    expect(await executor.claim(10, 2)).toHaveLength(2);
    const { rows } = await db.query<{ state: string; tasks: number }>(
      "select state, count(*)::int as tasks from absurd.r_turns group by state order by state",
    );
    // The two unclaimed tasks have no run in `running`: they are still waiting for any worker.
    expect(rows).toEqual([
      { state: "pending", tasks: 2 },
      { state: "running", tasks: 2 },
    ]);
    expect(await executor.claim(10, 0)).toEqual([]);
  });

  it("claims only its own queue's tasks, and counts only that queue's runs against the limit", async () => {
    const db = await tenant();
    const ran: string[] = [];
    const handlers: Partial<TaskHandlers> = {
      "run-turn": async (params) => {
        ran.push(`turn ${params.conversationId}`);
      },
      "index-conversation": async (params) => {
        ran.push(`index ${params.conversationId}`);
      },
    };
    const turns = createTenantExecutor(db, handlers, { workerId: "w" });
    const index = createTenantExecutor(db, handlers, { workerId: "w", queue: "index" });
    for (const conversationId of ["i1", "i2"]) {
      await db.transaction((tx) =>
        spawnInTx(tx, "index-conversation", { conversationId }, { idempotencyKey: conversationId }),
      );
    }
    expect(await turns.claim(5)).toEqual([]);

    // The running index task fills the index limit of 1, yet leaves the tenant's one turn slot free.
    const [indexing] = await index.claim(1);
    expect(indexing?.task_name).toBe("index-conversation");
    expect(await index.claim(1)).toEqual([]);
    for (const key of ["t1", "t2"]) {
      await db.transaction((tx) =>
        spawnInTx(tx, "run-turn", { conversationId: key, seq: 1 }, { idempotencyKey: key }),
      );
    }
    const [turning] = await turns.claim(1);
    expect(turning?.task_name).toBe("run-turn");
    expect(await turns.claim(1)).toEqual([]);
    // And the running turn does not count against the index limit of 2.
    const [second] = await index.claim(2);
    expect(second?.task_name).toBe("index-conversation");

    for (const task of [indexing, turning, second]) {
      const executor = task?.task_name === "run-turn" ? turns : index;
      await executor.execute(task as NonNullable<typeof task>);
    }
    expect(ran.sort()).toEqual(["index i1", "index i2", "turn t1"]);
    const { rows } = await db.query<{ state: string; tasks: number }>(
      "select state, count(*)::int as tasks from absurd.t_index group by state",
    );
    expect(rows).toEqual([{ state: "completed", tasks: 2 }]);
  });

  it("fences the first run out once its lease lapsed and a second worker took over", async () => {
    const db = await tenant();
    await db.query("create table effects (run text not null)");
    const firstMayWrite = Promise.withResolvers<void>();
    const firstResult = Promise.withResolvers<boolean>();

    const writeIfCurrent =
      (name: string): TaskHandlers["run-turn"] =>
      async (_params, run) => {
        if (name === "first") await firstMayWrite.promise;
        const wrote = await db.transaction(async (tx) => {
          if (!(await holdsRun(tx, run))) return false;
          await tx.query("insert into effects (run) values ($1)", [name]);
          return true;
        });
        if (name === "first") firstResult.resolve(wrote);
      };

    // The first worker never heartbeats (interval far beyond the test), so its 1 s lease lapses.
    const first = createTenantExecutor(
      db,
      { "run-turn": writeIfCurrent("first") },
      {
        workerId: "first",
        claimTimeoutSeconds: 1,
        heartbeatEveryMs: 600_000,
      },
    );
    const second = createTenantExecutor(
      db,
      { "run-turn": writeIfCurrent("second") },
      { workerId: "second" },
    );

    await spawn(db, "k", { kind: "fixed", baseSeconds: 0 });
    const [task] = await first.claim(1);
    const firstDone = first.execute(task as NonNullable<typeof task>);

    let takeover: Awaited<ReturnType<typeof second.claim>> = [];
    for (let i = 0; i < 40 && takeover.length === 0; i++) {
      await sleep(250);
      takeover = await second.claim(1);
    }
    expect(takeover).toHaveLength(1);
    await second.execute(takeover[0] as NonNullable<(typeof takeover)[number]>);

    firstMayWrite.resolve();
    await firstDone;
    expect(await firstResult.promise).toBe(false);
    expect((await db.query("select run from effects")).rows).toEqual([{ run: "second" }]);
  });
});

describe("cleanup", () => {
  it("deletes finished tasks past the queue's retention and keeps pending ones", async () => {
    const db = await tenant();
    const executor = createTenantExecutor(db, { "run-turn": async () => {} }, { workerId: "w" });
    await spawn(db, "done");
    const [task] = await executor.claim(1);
    await executor.execute(task as NonNullable<typeof task>);
    await spawn(db, "pending");

    expect(await cleanup(db)).toBe(0); // default retention is 30 days
    await db.query("update absurd.queues set cleanup_ttl = interval '0 seconds'");
    expect(await cleanup(db)).toBe(1);
    const { rows } = await db.query<{ state: string }>("select state from absurd.t_turns");
    expect(rows).toEqual([{ state: "pending" }]);
  });
});
