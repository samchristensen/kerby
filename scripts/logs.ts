// `make logs-query`: Kerby's JSON log lines, filtered, oldest first, one per line with the service that wrote it.
// Locally it reads `docker compose logs` of the stack KERBY_PROJECT names; with `--env <name>` it reads `railway logs
// --json` of that Railway environment (read only; run from a checkout linked with `railway link`). Railway keeps the
// logs of a service's current deployment here; older deployments are in the dashboard.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const SERVICES = ["control", "api", "worker", "console"] as const;
const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

/** One log line: Kerby's fields plus the service that wrote it. */
export type LogLine = {
  at: string;
  level: string;
  msg: string;
  tenantId: string | null;
  service: string;
  [field: string]: unknown;
};

export type LogFilter = {
  tenantId?: string;
  /** The least severe level kept: `warn` keeps warn and error. */
  level?: Level;
  /** A substring of `msg`, any case. */
  msg?: string;
  service?: string;
  since?: Date;
  until?: Date;
};

/**
 * A line of output as a log line, or undefined when it is not one (a stack trace, a tool's own output). Railway's JSON
 * renames `msg` to `message` and adds `timestamp`; both shapes come out as Kerby's.
 */
export function parseLine(raw: string, service: string): LogLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { msg, message, at, timestamp, level, tenantId, ...rest } = parsed as Record<
    string,
    unknown
  >;
  const text = msg ?? message;
  const time = at ?? timestamp;
  if (typeof text !== "string" || typeof time !== "string" || typeof level !== "string") {
    return undefined;
  }
  if (Number.isNaN(Date.parse(time))) return undefined;
  return {
    at: time,
    level,
    msg: text,
    tenantId: typeof tenantId === "string" ? tenantId : null,
    service,
    ...rest,
  };
}

function matches(line: LogLine, filter: LogFilter): boolean {
  if (filter.tenantId !== undefined && line.tenantId !== filter.tenantId) return false;
  if (filter.service !== undefined && line.service !== filter.service) return false;
  if (filter.level !== undefined) {
    const rank = LEVELS.indexOf(line.level as Level);
    if (rank < LEVELS.indexOf(filter.level)) return false;
  }
  if (filter.msg !== undefined && !line.msg.toLowerCase().includes(filter.msg.toLowerCase())) {
    return false;
  }
  const at = Date.parse(line.at);
  if (filter.since !== undefined && at < filter.since.getTime()) return false;
  if (filter.until !== undefined && at > filter.until.getTime()) return false;
  return true;
}

/** The matching lines of `output` from `service`, oldest first. */
export function query(
  outputs: { service: string; output: string }[],
  filter: LogFilter,
): LogLine[] {
  return outputs
    .flatMap(({ service, output }) =>
      output.split("\n").flatMap((raw) => parseLine(raw, service) ?? []),
    )
    .filter((line) => matches(line, filter))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** `30m` (s, m, h, d, w: that long before `now`) or an ISO 8601 time. */
export function parseTime(value: string, now: Date): Date {
  const relative = /^(\d+)([smhdw])$/.exec(value);
  if (relative) {
    const [, amount, unit] = relative;
    return new Date(now.getTime() - Number(amount) * (UNITS[unit ?? "s"] ?? 1) * 1000);
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new Error(
      `"${value}" is not a time. Fix: use a duration back from now (30s, 15m, 2h, 1d, 1w) or ISO 8601 (2026-11-22T10:00:00Z)`,
    );
  }
  return new Date(time);
}

export function parseFilter(args: string[], now: Date): { filter: LogFilter; env?: string } {
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: "string" },
      level: { type: "string" },
      msg: { type: "string" },
      service: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      env: { type: "string" },
    },
  });
  const level = values.level;
  if (level !== undefined && !LEVELS.some((l) => l === level)) {
    throw new Error(`level "${level}" is unknown. Fix: one of ${LEVELS.join(", ")}`);
  }
  const service = values.service;
  if (service !== undefined && !SERVICES.some((s) => s === service)) {
    throw new Error(`service "${service}" is unknown. Fix: one of ${SERVICES.join(", ")}`);
  }
  const filter: LogFilter = {
    ...(values.tenant === undefined ? {} : { tenantId: values.tenant }),
    ...(level === undefined ? {} : { level: level as Level }),
    ...(values.msg === undefined ? {} : { msg: values.msg }),
    ...(service === undefined ? {} : { service }),
    ...(values.since === undefined ? {} : { since: parseTime(values.since, now) }),
    ...(values.until === undefined ? {} : { until: parseTime(values.until, now) }),
  };
  return { filter, ...(values.env === undefined ? {} : { env: values.env }) };
}

/** Each service's raw output for the window: Railway's JSON for `env`, else the local Compose stack's. */
function read(filter: LogFilter, env: string | undefined): { service: string; output: string }[] {
  const services = filter.service === undefined ? SERVICES : [filter.service];
  const window = [
    ...(filter.since ? ["--since", filter.since.toISOString()] : []),
    ...(filter.until ? ["--until", filter.until.toISOString()] : []),
  ];
  const run = (args: string[]) =>
    execFileSync(args[0] ?? "", args.slice(1), {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "inherit"],
    });
  return services.map((service) => ({
    service,
    output:
      env === undefined
        ? run(["docker", "compose", "logs", "--no-log-prefix", "--no-color", ...window, service])
        : // Without a window `railway logs` streams forever: default to the last hour.
          run([
            "railway",
            "logs",
            "--json",
            "--service",
            service,
            "--environment",
            env,
            ...(filter.since ? [] : ["--since", "1h"]),
            ...window,
          ]),
  }));
}

if (import.meta.main) {
  try {
    const { filter, env } = parseFilter(process.argv.slice(2), new Date());
    for (const line of query(read(filter, env), filter)) console.log(JSON.stringify(line));
  } catch (error) {
    console.error(`logs-query: ${(error as Error).message}`);
    process.exit(1);
  }
}
