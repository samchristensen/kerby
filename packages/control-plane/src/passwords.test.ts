import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.ts";

/** A cheap scrypt for tests; production uses `PASSWORD_COST`. */
const COST = 10;
const PASSWORD = "correct horse battery";

describe("passwords", () => {
  it("verifies the password it hashed and nothing else", async () => {
    const stored = await hashPassword(PASSWORD, COST);
    expect(stored).toMatch(/^scrypt\$10\$8\$1\$/);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("correct horse battery!", stored)).toBe(false);
    expect(await hashPassword(PASSWORD, COST)).not.toBe(stored); // a salt per hash
    // a hash this code would not make, or one demanding too much memory, is a mismatch rather than a crash
    for (const bad of [
      "",
      "plain",
      stored.replace("$10$", "$0$"),
      stored.replace("$10$", "$30$"),
    ]) {
      expect(await verifyPassword(PASSWORD, bad), bad).toBe(false);
    }
  });
});
