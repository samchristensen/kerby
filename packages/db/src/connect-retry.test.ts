import { describe, expect, it } from "vitest";
import { isConnectionError, withConnectRetry } from "./connect-retry.ts";

const withCode = (code: string) => Object.assign(new Error(code), { code });

describe("isConnectionError", () => {
  it("retries what a resuming or restarting server causes, and nothing a retry cannot fix", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P03", "08006"]) {
      expect(isConnectionError(withCode(code)), code).toBe(true);
    }
    expect(isConnectionError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    // wrong password, missing database, permission denied, a SQL error, a plain bug
    for (const code of ["28P01", "3D000", "42501", "23505"])
      expect(isConnectionError(withCode(code)), code).toBe(false);
    expect(isConnectionError(new Error("boom"))).toBe(false);
  });
});

describe("withConnectRetry", () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 2 };

  it("returns once a later attempt succeeds", async () => {
    let calls = 0;
    const value = await withConnectRetry(async () => {
      if (++calls < 3) throw withCode("ECONNREFUSED");
      return "connected";
    }, fast);
    expect([value, calls]).toEqual(["connected", 3]);
  });

  it("gives up after the attempts and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withConnectRetry(
        async () => {
          calls++;
          throw withCode("ETIMEDOUT");
        },
        { ...fast, attempts: 4 },
      ),
    ).rejects.toThrow("ETIMEDOUT");
    expect(calls).toBe(4);
  });

  it("does not retry an error that waiting cannot fix", async () => {
    let calls = 0;
    await expect(
      withConnectRetry(async () => {
        calls++;
        throw withCode("28P01");
      }, fast),
    ).rejects.toThrow("28P01");
    expect(calls).toBe(1);
  });
});
