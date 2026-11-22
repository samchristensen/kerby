// Structured logs: one JSON object per line on stdout. Every line carries `tenantId`: the tenant of the
// surrounding `withTenant`, or null for system work. Content never reaches a log (principle 8): fields are
// scalars only, and keys that usually hold message or secret content are dropped and named in `redacted`. Alerts
// (below) are error lines an operator also receives through a webhook, under the same rules.
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

/** The fields a log line or an alert may carry, and the names of those dropped (principle 8). */
function scrub(fields: LogFields): { kept: Record<string, Scalar>; redacted: string[] } {
  const kept: Record<string, Scalar> = {};
  const redacted: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN.has(key.toLowerCase())) redacted.push(key);
    else if (typeof value === "object" && value !== null) redacted.push(key);
    else kept[key] = value;
  }
  return { kept, redacted };
}

export function log(level: Level, msg: string, fields: LogFields = {}): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const { kept, redacted } = scrub(fields);
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

// Alerts: failures an operator must hear about. Each is an error line with `alert: <kind>` and, when the operator set a
// webhook (ALERT_WEBHOOK_URL), a post to it: at most one per kind per five minutes, the next one counting those held
// back. An alert never throws and never waits: it runs where something already failed.

const DEBOUNCE_MS = 5 * 60_000;

export type AlertOptions = {
  /** Names the process in each post (`control`, `api`, `worker`). */
  service: string;
  /** Names the deployment (the Railway environment), so copies of production that share a channel tell apart. */
  environment?: string | undefined;
  /** Slack (`hooks.slack.com`), Discord (`discord.com/api/webhooks`) or any URL taking JSON. Unset: log lines only. */
  webhookUrl?: string | undefined;
  /** A post slower than this is abandoned and logged; default five seconds. */
  timeoutMs?: number;
  /** The transport, for tests that point every URL at a local receiver; default `fetch`. */
  post?: typeof fetch;
};

/** What one post says; Slack and Discord get it as one line of text. */
export type AlertMessage = {
  alert: string;
  service: string;
  environment: string | null;
  at: string;
  tenantId: string | null;
  fields: Record<string, Scalar>;
  /** Alerts of this kind logged but not posted since the previous post. */
  suppressed: number;
};

type AlertSettings = Required<Omit<AlertOptions, "webhookUrl" | "environment">> & {
  webhookUrl: URL | undefined;
  environment: string | null;
};
let alerting: AlertSettings = {
  service: "kerby",
  environment: null,
  webhookUrl: undefined,
  timeoutMs: 5000,
  post: (input, init) => fetch(input, init),
};
/** Per kind: when its window opened and how many alerts it held back. */
const windows = new Map<string, { opened: number; suppressed: number }>();
const inFlight = new Set<Promise<void>>();

/** Set where alerts go; called once at startup with the service's config. Resets the debounce windows. */
export function configureAlerts(options: AlertOptions): void {
  alerting = {
    service: options.service,
    environment: options.environment ?? null,
    webhookUrl: options.webhookUrl === undefined ? undefined : new URL(options.webhookUrl),
    timeoutMs: options.timeoutMs ?? 5000,
    post: options.post ?? ((input, init) => fetch(input, init)),
  };
  windows.clear();
}

/** Log `kind` at error level and post it to the webhook, if any. `kind` is the log line's `msg` too. */
export function alert(kind: string, fields: LogFields = {}): void {
  try {
    log("error", kind, { ...fields, alert: kind });
    const url = alerting.webhookUrl;
    if (url === undefined) return;
    const now = Date.now();
    const open = windows.get(kind);
    if (open && now - open.opened < DEBOUNCE_MS) {
      open.suppressed += 1;
      return;
    }
    windows.set(kind, { opened: now, suppressed: 0 });
    const message: AlertMessage = {
      alert: kind,
      service: alerting.service,
      environment: alerting.environment,
      at: new Date(now).toISOString(),
      tenantId: currentTenantId(),
      fields: scrub(fields).kept,
      suppressed: open?.suppressed ?? 0,
    };
    const sending = send(alerting, url, message);
    inFlight.add(sending);
    void sending.finally(() => inFlight.delete(sending));
  } catch {
    // A failing sink or a bad field must not turn the failure being reported into a second one.
  }
}

/** Wait for the posts under way: tests, and services on shutdown so a last alert is not cut off. */
export async function flushAlerts(): Promise<void> {
  await Promise.all([...inFlight]);
}

async function send(settings: AlertSettings, url: URL, message: AlertMessage): Promise<void> {
  try {
    const response = await settings.post(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alertPayload(url, message)),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok) {
      log("error", "alert post failed", { alert: message.alert, status: response.status });
    }
  } catch (error) {
    log("error", "alert post failed", { alert: message.alert, ...errorFields(error) });
  }
}

/** The body for `url`: Slack and Discord take text (`text`, `content`); anything else gets the message as JSON. */
function alertPayload(url: URL, message: AlertMessage): object {
  const discord =
    (url.hostname === "discord.com" || url.hostname === "discordapp.com") &&
    url.pathname.startsWith("/api/webhooks/");
  if (url.hostname !== "hooks.slack.com" && !discord) return message;
  const details = Object.entries(message.fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  const text = [
    `kerby ${message.service}`,
    message.environment === null ? "" : ` (${message.environment})`,
    `: ${message.alert}`,
    message.tenantId === null ? "" : ` (tenant ${message.tenantId})`,
    details.length > 0 ? `; ${details.join(", ")}` : "",
    message.suppressed > 0
      ? `. ${message.suppressed} more since the previous post, not posted`
      : "",
  ]
    .join("")
    // Discord refuses content over 2000 characters.
    .slice(0, 1900);
  return discord ? { content: text } : { text };
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
