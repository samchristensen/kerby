import { describe, expect, it } from "vitest";
import { parseFilter, parseLine, parseTime, query } from "./logs.ts";

const NOW = new Date("2026-11-22T12:00:00.000Z");

// What `docker compose logs --no-log-prefix kerby` prints: lines the launcher tagged with the process that wrote them,
// plus whatever else a process wrote.
const kerby = [
  '{"service":"worker","at":"2026-11-22T11:00:00.000Z","level":"info","msg":"worker started","tenantId":null,"workerId":"w1"}',
  '{"service":"worker","at":"2026-11-22T11:50:00.000Z","level":"info","msg":"turn completed","tenantId":"t1","attempt":1}',
  '{"service":"control","at":"2026-11-22T11:52:00.000Z","level":"error","msg":"provisioning failed","tenantId":"t1","alert":"provisioning failed"}',
  '{"service":"worker","at":"2026-11-22T11:55:00.000Z","level":"error","msg":"turn failed for good","tenantId":"t2","alert":"turn failed for good"}',
  "    at Object.<anonymous> (/app/x.ts:1:1)",
  '{"service":"worker","at":"2026-11-22T11:56:00.000Z","level":"warn","msg":"sweep failed","tenantId":null}',
  "",
].join("\n");
// The console's lines carry no service: they are the console's.
const consoleOutput =
  '{"at":"2026-11-22T10:59:00.000Z","level":"info","msg":"console listening","tenantId":null}';
const outputs = [
  { container: "kerby", output: kerby },
  { container: "console", output: consoleOutput },
];
const msgs = (filter: Parameters<typeof query>[1]) => query(outputs, filter).map((l) => l.msg);

describe("logs-query", () => {
  it("names each line's process, skips lines that are not log lines, and sorts by time", () => {
    expect(msgs({})).toEqual([
      "console listening",
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
    expect(query(outputs, { service: "console" })).toEqual([
      expect.objectContaining({ msg: "console listening", service: "console" }),
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
    expect(msgs({ service: "control" })).toEqual(["provisioning failed"]);
    expect(
      msgs({ since: parseTime("10m", NOW), until: parseTime("2026-11-22T11:55:30Z", NOW) }),
    ).toEqual(["turn completed", "provisioning failed", "turn failed for good"]);
    expect(msgs({ level: "error", service: "worker", tenantId: "t2" })).toEqual([
      "turn failed for good",
    ]);
  });

  it("parses the command line, and says how to fix a bad value", () => {
    expect(parseFilter(["--tenant", "t1", "--level", "warn", "--since", "1h"], NOW)).toEqual({
      tenantId: "t1",
      level: "warn",
      since: new Date("2026-11-22T11:00:00.000Z"),
    });
    expect(() => parseFilter(["--level", "fatal"], NOW)).toThrow(/one of debug, info, warn, error/);
    expect(() => parseFilter(["--service", "db"], NOW)).toThrow(
      /one of control, api, worker, dispatcher, console/,
    );
    expect(() => parseTime("yesterday", NOW)).toThrow(/30s, 15m, 2h, 1d, 1w/);
  });

  it("is not fooled by JSON that is not a log line", () => {
    expect(parseLine("[1,2]", "kerby")).toBeUndefined();
    expect(parseLine('{"level":"info","msg":"no time"}', "kerby")).toBeUndefined();
    expect(parseLine('{"at":"not a time","level":"info","msg":"x"}', "kerby")).toBeUndefined();
  });
});
