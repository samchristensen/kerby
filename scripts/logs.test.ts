import { describe, expect, it } from "vitest";
import { parseFilter, parseLine, parseTime, query } from "./logs.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");

// What `docker compose logs --no-log-prefix` prints: Kerby's lines, plus whatever else a process wrote.
const worker = [
  '{"at":"2026-11-22T11:00:00.000Z","level":"info","msg":"worker started","tenantId":null,"workerId":"w1"}',
  '{"at":"2026-11-22T11:50:00.000Z","level":"info","msg":"turn completed","tenantId":"t1","attempt":1}',
  '{"at":"2026-11-22T11:55:00.000Z","level":"error","msg":"turn failed for good","tenantId":"t2","alert":"turn failed for good"}',
  "    at Object.<anonymous> (/app/x.ts:1:1)",
  '{"at":"2026-11-22T11:56:00.000Z","level":"warn","msg":"sweep failed","tenantId":null}',
  "",
].join("\n");
// What `railway logs --json` prints: Railway renames `msg` to `message` and adds its own lines.
const control = [
  '{"message":"Starting Container","timestamp":"2026-11-22T10:59:00.000Z","level":"info"}',
  '{"at":"2026-11-22T11:52:00.000Z","message":"provisioning failed","tenantId":"t1","timestamp":"2026-11-22T11:52:00.500Z","level":"error","alert":"provisioning failed"}',
].join("\n");
const outputs = [
  { service: "worker", output: worker },
  { service: "control", output: control },
];
const msgs = (filter: Parameters<typeof query>[1]) => query(outputs, filter).map((l) => l.msg);

describe("logs-query", () => {
  it("reads both shapes, skips lines that are not log lines, and sorts by time", () => {
    expect(msgs({})).toEqual([
      "Starting Container",
      "worker started",
      "turn completed",
      "provisioning failed",
      "turn failed for good",
      "sweep failed",
    ]);
    expect(query(outputs, { tenantId: "t1" })).toEqual([
      expect.objectContaining({ msg: "turn completed", service: "worker", attempt: 1 }),
      {
        at: "2026-11-22T11:52:00.000Z",
        level: "error",
        msg: "provisioning failed",
        tenantId: "t1",
        service: "control",
        alert: "provisioning failed",
      },
    ]);
  });

  it("filters by tenant, minimum level, message substring, service and time window", () => {
    expect(msgs({ tenantId: "t2" })).toEqual(["turn failed for good"]);
    expect(msgs({ level: "warn" })).toEqual([
      "provisioning failed",
      "turn failed for good",
      "sweep failed",
    ]);
    expect(msgs({ msg: "FAILED for" })).toEqual(["turn failed for good"]);
    expect(msgs({ service: "control" })).toEqual(["Starting Container", "provisioning failed"]);
    expect(
      msgs({ since: parseTime("10m", NOW), until: parseTime("2026-11-22T11:55:30Z", NOW) }),
    ).toEqual(["turn completed", "provisioning failed", "turn failed for good"]);
    expect(msgs({ level: "error", service: "worker", tenantId: "t2" })).toEqual([
      "turn failed for good",
    ]);
  });

  it("parses the command line, and says how to fix a bad value", () => {
    expect(
      parseFilter(["--tenant", "t1", "--level", "warn", "--since", "1h", "--env", "pr-7"], NOW),
    ).toEqual({
      filter: { tenantId: "t1", level: "warn", since: new Date("2026-11-22T11:00:00.000Z") },
      env: "pr-7",
    });
    expect(() => parseFilter(["--level", "fatal"], NOW)).toThrow(/one of debug, info, warn, error/);
    expect(() => parseFilter(["--service", "db"], NOW)).toThrow(/one of control, api, worker/);
    expect(() => parseTime("yesterday", NOW)).toThrow(/30s, 15m, 2h, 1d, 1w/);
  });

  it("is not fooled by JSON that is not a log line", () => {
    expect(parseLine("[1,2]", "api")).toBeUndefined();
    expect(parseLine('{"level":"info","msg":"no time"}', "api")).toBeUndefined();
    expect(parseLine('{"at":"not a time","level":"info","msg":"x"}', "api")).toBeUndefined();
  });
});
