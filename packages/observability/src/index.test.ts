import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureLogging, errorFields, log, withTenant } from "./index.ts";

let lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines = [];
  configureLogging({ level: "info", write: (line) => lines.push(JSON.parse(line)) });
});
afterEach(() => {
  configureLogging({ level: "info", write: (line) => process.stdout.write(line) });
});

describe("log", () => {
  it("tags lines with the surrounding tenant, across awaits, and null outside", async () => {
    log("info", "outside");
    await withTenant("tenant-a", async () => {
      await Promise.resolve();
      log("info", "inside");
      await withTenant("tenant-b", async () => {
        await new Promise((resolve) => setImmediate(resolve));
        log("info", "nested");
      });
      log("info", "back");
    });
    expect(lines.map((l) => [l.msg, l.tenantId])).toEqual([
      ["outside", null],
      ["inside", "tenant-a"],
      ["nested", "tenant-b"],
      ["back", "tenant-a"],
    ]);
  });

  it("drops content-carrying and non-scalar fields and names them", () => {
    withTenant("t", () => {
      // @ts-expect-error `content` is not a permitted log field
      log("info", "turn", { content: "the customer's words", conversationId: "c1" });
      // @ts-expect-error objects are not scalars
      log("info", "turn", { detail: { text: "hi" } });
    });
    expect(lines[0]).toMatchObject({ conversationId: "c1", redacted: ["content"] });
    expect(lines[1]).toMatchObject({ redacted: ["detail"] });
    expect(JSON.stringify(lines)).not.toContain("customer's words");
    expect(JSON.stringify(lines)).not.toContain("hi");
  });

  it("does not let fields overwrite the tenant id", () => {
    withTenant("real", () => {
      // @ts-expect-error tenantId is not a field
      log("info", "x", { tenantId: "forged" });
    });
    expect(lines[0]).toMatchObject({ tenantId: "real", redacted: ["tenantId"] });
  });

  it("honors the minimum level", () => {
    configureLogging({ level: "warn" });
    log("info", "quiet");
    log("error", "loud");
    expect(lines.map((l) => l.msg)).toEqual(["loud"]);
  });

  it("describes an error without its stack", () => {
    const error = Object.assign(new Error("boom"), { code: "23505" });
    expect(errorFields(error)).toEqual({
      errorName: "Error",
      errorMessage: "boom",
      errorCode: "23505",
    });
  });
});
