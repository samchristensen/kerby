import { describe, expect, it } from "vitest";
import { clientAddress, TokenBuckets } from "./index.ts";

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

describe("client address", () => {
  it("is the socket's peer unless a trusted proxy names the client first", () => {
    expect(clientAddress("203.0.113.9, 10.0.0.1", "10.0.0.1", false)).toBe("10.0.0.1");
    expect(clientAddress("203.0.113.9, 10.0.0.1", "10.0.0.1", true)).toBe("203.0.113.9");
    expect(clientAddress(undefined, "10.0.0.1", true)).toBe("10.0.0.1");
    expect(clientAddress(" ", "10.0.0.1", true)).toBe("10.0.0.1");
  });
});
