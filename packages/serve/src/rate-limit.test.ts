import { describe, expect, it } from "vitest";
import { clientAddress, TokenBuckets, TurnsPerKey } from "./index.ts";

describe("token buckets", () => {
  it("refills continuously, up to a minute's worth", () => {
    let clock = 0;
    const buckets = new TokenBuckets({ maxKeys: 10, now: () => clock });
    for (let i = 0; i < 60; i++) expect(buckets.take("t", 60)).toBe(0);
    expect(buckets.take("t", 60)).toBe(1);
    clock += 999;
    expect(buckets.take("t", 60)).toBe(1);
    clock += 1;
    expect(buckets.take("t", 60)).toBe(0);
    expect(buckets.take("t", 60)).toBe(1);
    clock += 10 * 60_000; // a long pause refills to a minute's worth, not more
    for (let i = 0; i < 60; i++) expect(buckets.take("t", 60)).toBe(0);
    expect(buckets.take("t", 60)).toBe(1);
  });

  it("counts over its window: 5 an hour is one token every 12 minutes", () => {
    let clock = 0;
    const buckets = new TokenBuckets({ maxKeys: 10, windowMs: 3_600_000, now: () => clock });
    for (let i = 0; i < 5; i++) expect(buckets.take("a", 5)).toBe(0);
    expect(buckets.take("a", 5)).toBe(720);
    expect(buckets.wait("a", 5)).toBe(720);
    clock += 12 * 60_000;
    expect(buckets.wait("a", 5)).toBe(0);
    expect(buckets.take("a", 5)).toBe(0);
    expect(buckets.take("a", 5)).toBe(720);
  });

  it("forgets the least recently used key past its bound", () => {
    const buckets = new TokenBuckets({ maxKeys: 2, now: () => 0 });
    expect(buckets.take("a", 1)).toBe(0);
    expect(buckets.take("a", 1)).toBe(60);
    buckets.take("b", 1);
    buckets.take("c", 1); // evicts "a"
    expect(buckets.take("a", 1)).toBe(0);
  });
});

describe("turns per key", () => {
  it("runs at most so many of one key at once, the rest in arrival order, without holding up other keys", async () => {
    const turns = new TurnsPerKey(2);
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const started: string[] = [];
    const runs = gates.map((gate, i) =>
      turns.run("a", async () => {
        started.push(`a${i}`);
        await gate.promise;
      }),
    );
    await turns.run("b", async () => {
      started.push("b");
    });
    expect(started).toEqual(["a0", "a1", "b"]);
    gates[1]?.resolve();
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual(["a0", "a1", "b", "a2"]);
    gates[0]?.resolve();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual(["a0", "a1", "b", "a2", "a3"]);
    gates[2]?.resolve();
    gates[3]?.resolve();
    await Promise.all(runs);
  });

  it("passes its turn on when a run fails", async () => {
    const turns = new TurnsPerKey(1);
    const failed = turns.run("a", () => Promise.reject(new Error("boom")));
    const next = turns.run("a", async () => "ran");
    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("ran");
  });
});

describe("client address", () => {
  it("is the socket's peer unless a trusted proxy names the client first", () => {
    expect(clientAddress("203.0.113.9, 10.0.0.1", "10.0.0.1", false)).toBe("10.0.0.1");
    expect(clientAddress("203.0.113.9, 10.0.0.1", "10.0.0.1", true)).toBe("203.0.113.9");
    expect(clientAddress(undefined, "10.0.0.1", true)).toBe("10.0.0.1");
    expect(clientAddress(" ", "10.0.0.1", true)).toBe("10.0.0.1");
  });
});
