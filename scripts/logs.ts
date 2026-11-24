// `make logs-query`: Kerby's JSON log lines, filtered, oldest first, one per line with the service that wrote it. It reads
// `docker compose logs` of the stack KERBY_PROJECT names. The kerby container's launcher tags each line with the
// process that wrote it (`service`: control, api, worker, dispatcher); the console's lines are the console's.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const SERVICES = ["control", "api", "worker", "dispatcher", "console"] as const;
/** The Compose services whose output holds Kerby's lines. */
const CONTAINERS = ["kerby", "console"] as const;
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
 * A line of `container`'s output as a log line, or undefined when it is not one (a stack trace, a tool's own output).
 * Its service is the `service` the launcher tagged it with, else the container's name.
 */
export function parseLine(raw: string, container: string): LogLine | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const { msg, at, level, tenantId, service, ...rest } = parsed as Record<string, unknown>;
  if (typeof msg !== "string" || typeof at !== "string" || typeof level !== "string") {
    return undefined;
  }
  if (Number.isNaN(Date.parse(at))) return undefined;
  return {
    at,
    level,
    msg,
    tenantId: typeof tenantId === "string" ? tenantId : null,
    service: typeof service === "string" ? service : container,
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

/** The matching lines of each container's `output`, oldest first. */
export function query(
  outputs: { container: string; output: string }[],
  filter: LogFilter,
): LogLine[] {
  return outputs
    .flatMap(({ container, output }) =>
      output.split("\n").flatMap((raw) => parseLine(raw, container) ?? []),
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

export function parseFilter(args: string[], now: Date): LogFilter {
  const { values } = parseArgs({
    args,
    options: {
      tenant: { type: "string" },
      level: { type: "string" },
      msg: { type: "string" },
      service: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
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
  return {
    ...(values.tenant === undefined ? {} : { tenantId: values.tenant }),
    ...(level === undefined ? {} : { level: level as Level }),
    ...(values.msg === undefined ? {} : { msg: values.msg }),
    ...(service === undefined ? {} : { service }),
    ...(values.since === undefined ? {} : { since: parseTime(values.since, now) }),
    ...(values.until === undefined ? {} : { until: parseTime(values.until, now) }),
  };
}

/** Each container's raw output for the window, from the local Compose stack. */
function read(filter: LogFilter): { container: string; output: string }[] {
  const containers = filter.service === "console" ? ["console"] : CONTAINERS;
  const window = [
    ...(filter.since ? ["--since", filter.since.toISOString()] : []),
    ...(filter.until ? ["--until", filter.until.toISOString()] : []),
  ];
  return containers.map((container) => ({
    container,
    output: execFileSync(
      "docker",
      ["compose", "logs", "--no-log-prefix", "--no-color", ...window, container],
      { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] },
    ),
  }));
}

if (import.meta.main) {
  try {
    const filter = parseFilter(process.argv.slice(2), new Date());
    for (const line of query(read(filter), filter)) console.log(JSON.stringify(line));
  } catch (error) {
    console.error(`logs-query: ${(error as Error).message}`);
    process.exit(1);
  }
}
