import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alert,
  configureAlerts,
  configureLogging,
  errorFields,
  flushAlerts,
  log,
  withTenant,
} from "./index.ts";

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

describe("alert", () => {
  type Received = { path: string; body: unknown };
  let received: Received[] = [];
  let receiver: Server;
  let base = "";

  beforeEach(async () => {
    received = [];
    receiver = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        received.push({ path: request.url ?? "", body: JSON.parse(raw) });
        response.statusCode = request.url?.includes("refuse") ? 500 : 204;
        response.end();
      });
    });
    const listening = Promise.withResolvers<void>();
    receiver.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.useRealTimers();
    configureAlerts({ service: "kerby" });
    const closed = Promise.withResolvers<void>();
    receiver.close(() => closed.resolve());
    await closed.promise;
  });

  /** Alerts for `webhookUrl`, delivered to the local receiver at the same path. */
  function alertsTo(webhookUrl: string) {
    configureAlerts({
      service: "worker",
      environment: "production",
      webhookUrl,
      post: (input, init) => fetch(`${base}${new URL(String(input)).pathname}`, init),
    });
  }

  it("logs an error line tagged with the kind, and posts nothing without a webhook", async () => {
    configureAlerts({ service: "worker" });
    withTenant("t1", () => alert("turn failed for good", { attempt: 3 }));
    await flushAlerts();
    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        msg: "turn failed for good",
        alert: "turn failed for good",
        tenantId: "t1",
        attempt: 3,
      }),
    ]);
    expect(received).toEqual([]);
  });

  it("posts text to Slack, content to Discord, and the message as JSON elsewhere", async () => {
    const fields = { attempt: 3, ...errorFields(new Error("boom")) };
    alertsTo("https://hooks.slack.com/services/T0/B0/x");
    withTenant("t1", () => alert("turn failed for good", fields));
    await flushAlerts();
    alertsTo("https://discord.com/api/webhooks/1/abc");
    withTenant("t1", () => alert("turn failed for good", fields));
    await flushAlerts();
    alertsTo("https://alerts.example.com/hook");
    withTenant("t1", () => alert("turn failed for good", fields));
    await flushAlerts();

    const text =
      "kerby worker (production): turn failed for good (tenant t1); attempt=3, errorName=Error, errorMessage=boom";
    expect(received).toEqual([
      { path: "/services/T0/B0/x", body: { text } },
      { path: "/api/webhooks/1/abc", body: { content: text } },
      {
        path: "/hook",
        body: {
          alert: "turn failed for good",
          service: "worker",
          environment: "production",
          at: expect.any(String),
          tenantId: "t1",
          fields: { attempt: 3, errorName: "Error", errorMessage: "boom" },
          suppressed: 0,
        },
      },
    ]);
  });

  it("posts a kind once per five minutes and counts the ones held back in the next post", async () => {
    // Only the clock is fake: the posts go over real sockets.
    vi.useFakeTimers({ toFake: ["Date"] });
    alertsTo("https://alerts.example.com/hook");
    alert("lease lost", { taskId: "a" });
    alert("lease lost", { taskId: "b" });
    alert("lease lost", { taskId: "c" });
    alert("provisioning failed");
    await flushAlerts();
    expect(received.map((r) => r.body)).toMatchObject([
      { alert: "lease lost", fields: { taskId: "a" }, suppressed: 0 },
      { alert: "provisioning failed" },
    ]);
    expect(lines.filter((l) => l.alert === "lease lost")).toHaveLength(3);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    alert("lease lost", { taskId: "d" });
    await flushAlerts();
    expect(received.at(-1)?.body).toMatchObject({ fields: { taskId: "d" }, suppressed: 2 });
  });

  it("keeps content and secrets out of the post", async () => {
    alertsTo("https://hooks.slack.com/services/T0/B0/x");
    // @ts-expect-error `content` is not a permitted field
    alert("provisioning failed", { content: "the customer's words", token: "sk-secret" });
    await flushAlerts();
    expect(JSON.stringify(received)).not.toContain("customer's words");
    expect(JSON.stringify(received)).not.toContain("sk-secret");
  });

  it("survives a dead or refusing receiver and logs the failed post", async () => {
    configureAlerts({ service: "worker", webhookUrl: "http://127.0.0.1:1/hook", timeoutMs: 1000 });
    expect(() => alert("lease lost")).not.toThrow();
    await flushAlerts();
    alertsTo("https://alerts.example.com/refuse");
    alert("lease lost");
    await flushAlerts();
    expect(lines.filter((l) => l.msg === "alert post failed")).toEqual([
      expect.objectContaining({ level: "error", alert: "lease lost", errorName: "TypeError" }),
      expect.objectContaining({ level: "error", alert: "lease lost", status: 500 }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("127.0.0.1:1");
  });
});
