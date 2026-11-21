// Structured logs: one JSON object per line on stdout. Every line carries `tenantId`: the tenant of the
// surrounding `withTenant`, or null for system work. Content never reaches a log (principle 8): fields are
// scalars only, and keys that usually hold message or secret content are dropped and named in `redacted`.
import { AsyncLocalStorage } from "node:async_hooks";

export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Scalars only: an object or array is how message bodies sneak into logs. */
export type Scalar = string | number | boolean | null | undefined;
export type LogFields = {
  [key: string]: Scalar;
  // The usual carriers of tenant content are type errors here and dropped at runtime.
  content?: never;
  text?: never;
  body?: never;
  prompt?: never;
  input?: never;
  output?: never;
  secret?: never;
  token?: never;
  password?: never;
  authorization?: never;
  apiKey?: never;
  tenantId?: never;
  level?: never;
  msg?: never;
  at?: never;
};

const FORBIDDEN = new Set([
  "content",
  "text",
  "body",
  "prompt",
  "input",
  "output",
  "secret",
  "token",
  "password",
  "authorization",
  "apikey",
  "tenantid", // set by withTenant only
  "level",
  "msg",
  "at",
]);

const tenants = new AsyncLocalStorage<string>();

/** Run `fn` with every log line inside it (including across awaits) tagged with `tenantId`. */
export function withTenant<T>(tenantId: string, fn: () => T): T {
  return tenants.run(tenantId, fn);
}

export function currentTenantId(): string | null {
  return tenants.getStore() ?? null;
}

type Sink = (line: string) => void;
let minLevel: Level = "info";
let sink: Sink = (line) => {
  process.stdout.write(line);
};

/** Set the minimum level and, for tests, the destination (each call receives one line ending in a newline). */
export function configureLogging(options: { level?: Level; write?: Sink }): void {
  if (options.level) minLevel = options.level;
  if (options.write) sink = options.write;
}

export function log(level: Level, msg: string, fields: LogFields = {}): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const kept: Record<string, Scalar> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN.has(key.toLowerCase())) redacted.push(key);
    else if (typeof value === "object" && value !== null) redacted.push(key);
    else kept[key] = value;
  }
  const line = {
    at: new Date().toISOString(),
    level,
    msg,
    tenantId: currentTenantId(),
    ...kept,
    ...(redacted.length > 0 ? { redacted } : {}),
  };
  sink(`${JSON.stringify(line)}\n`);
}

/** A string `code` property of an error (Node and Postgres errors have one), or undefined. */
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Fields describing an error: its class and message, never its stack or cause chain. */
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorName: "NonError" };
  const code = errorCode(error);
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(code === undefined ? {} : { errorCode: code }),
  };
}
