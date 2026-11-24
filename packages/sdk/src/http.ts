// The one place that talks HTTP: auth header, query encoding, time limits, retries, error mapping, response parsing.
// Resources call `request` (JSON in, parsed JSON out) or `send` (nothing to read back) and never touch `fetch`.
import { z } from "zod";
import {
  KerbyApiError,
  KerbyConnectionError,
  KerbyResponseError,
  KerbyTimeoutError,
} from "./errors.ts";

export type KerbyOptions = {
  /** An integration's API key (console > Integrations). Keep it on a server: it acts as your whole integration. */
  apiKey: string;
  /** The API's origin, e.g. `https://api.example.com` or `http://127.0.0.1:8080` for a local stack. */
  baseUrl: string | URL;
  /** Your own `fetch` (a proxy, a test double). Default: the global one. */
  fetch?: typeof globalThis.fetch;
  /** Per-request time limit, headers and body. Default 60 000 ms. Long polls and streams are not cut by it. */
  timeoutMs?: number;
  /** How often a failed request may be retried (429 always; network errors and 502/503/504 for GET, PUT, DELETE). Default 2. */
  maxRetries?: number;
  /** Sent with every request, e.g. a trace id. */
  headers?: Readonly<Record<string, string>>;
  /** Check every response against its contract and throw `KerbyResponseError` when it differs. Default true. */
  validateResponses?: boolean;
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type QueryValue = string | number | boolean | readonly string[] | undefined;
type Query = Readonly<Record<string, QueryValue>>;

export type RequestSpec = {
  method: Method;
  /** Path under the origin, already encoded: `/v1/conversations`. Use `segment()` for ids and names. */
  path: string;
  query?: Query;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Overrides the client's limit, for a long poll that is meant to outlast it. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
/** A `Retry-After` longer than this is returned to the caller instead of slept through. */
const MAX_RETRY_WAIT_SECONDS = 30;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/** One path segment, encoded: a prompt name's `/` becomes `%2F`, as the API expects. */
export const segment = (value: string | number): string => encodeURIComponent(String(value));

/** Resolve after `ms`, or reject with the signal's reason if it aborts first. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** How the API words every error: `{ "error": { "code", "message" } }`, plus `problems` for `unknown_tool`. */
const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    problems: z.unknown().optional(),
  }),
});

export class Transport {
  readonly #apiKey: string;
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #validate: boolean;

  constructor(options: KerbyOptions) {
    if (!options.apiKey) throw new TypeError("Kerby: apiKey is required");
    let origin: URL;
    try {
      origin = new URL(options.baseUrl);
    } catch {
      throw new TypeError(
        `Kerby: baseUrl must be an absolute URL such as https://api.example.com, got ${String(options.baseUrl)}`,
      );
    }
    this.#apiKey = options.apiKey;
    this.#origin = origin.origin + origin.pathname.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#headers = options.headers ?? {};
    this.#validate = options.validateResponses ?? true;
  }

  /** Make the request and return the body, parsed with `schema` (a 2xx body that does not match is a `KerbyResponseError`). */
  async request<S extends z.ZodType>(spec: RequestSpec & { schema: S }): Promise<z.output<S>> {
    const response = await this.#execute(spec);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw this.#failure(error, spec);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new KerbyResponseError(
        `${spec.method} ${spec.path} answered ${response.status} with a body that is not JSON`,
        spec.method,
        spec.path,
      );
    }
    return this.parse(spec.schema, body, spec);
  }

  /** Check `value` against its contract (or pass it through when `validateResponses` is off). */
  parse<S extends z.ZodType>(
    schema: S,
    value: unknown,
    spec: Pick<RequestSpec, "method" | "path">,
  ): z.output<S> {
    if (!this.#validate) return value as z.output<S>;
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
      .join("; ");
    throw new KerbyResponseError(
      `${spec.method} ${spec.path} answered a body that does not match the contract (${issues}); this SDK and the API may be out of step`,
      spec.method,
      spec.path,
    );
  }

  /** Make the request and discard the body (routes that answer 204). */
  async send(spec: RequestSpec): Promise<void> {
    const response = await this.#execute(spec);
    await response.body?.cancel();
  }

  /**
   * Open a server-sent-events response. No time limit and no retry: the caller owns the connection's life and reconnects.
   * A non-2xx answer throws the `KerbyApiError`.
   */
  async openStream(
    spec: Pick<RequestSpec, "path" | "query" | "signal"> & { headers?: Record<string, string> },
  ): Promise<ReadableStream<Uint8Array>> {
    const full: RequestSpec = { method: "GET", ...spec };
    let response: Response;
    try {
      response = await this.#fetch(this.#url(full), {
        method: "GET",
        headers: { ...this.#baseHeaders(), accept: "text/event-stream", ...spec.headers },
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
    } catch (error) {
      throw this.#failure(error, full);
    }
    if (!response.ok) throw await this.#apiError(response, full);
    if (!response.body) throw new KerbyConnectionError("the event stream had no body");
    return response.body;
  }

  #baseHeaders(): Record<string, string> {
    return { ...this.#headers, authorization: `Bearer ${this.#apiKey}` };
  }

  #url(spec: Pick<RequestSpec, "path" | "query">): string {
    const url = new URL(this.#origin + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, typeof value === "object" ? value.join(",") : String(value));
    }
    return url.toString();
  }

  /** Translate what `fetch` threw: the caller's own abort passes through; a time limit and a dead network are Kerby errors. */
  #failure(error: unknown, spec: RequestSpec): Error {
    if (spec.signal?.aborted)
      return spec.signal.reason instanceof Error
        ? spec.signal.reason
        : new Error(String(spec.signal.reason ?? "aborted"));
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      return new KerbyTimeoutError(`${spec.method} ${spec.path} timed out`);
    const reason = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    return new KerbyConnectionError(
      `${spec.method} ${spec.path} failed: ${reason}${cause ? ` (${cause})` : ""}`,
      { cause: error },
    );
  }

  async #execute(spec: RequestSpec): Promise<Response> {
    // Only a request that changes nothing twice is repeated after a failure that may have reached the server.
    const repeatable = spec.method === "GET" || spec.method === "PUT" || spec.method === "DELETE";
    const hasBody = spec.body !== undefined;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(spec.timeoutMs ?? this.#timeoutMs);
      const signal = spec.signal ? AbortSignal.any([timeout, spec.signal]) : timeout;
      let response: Response;
      try {
        response = await this.#fetch(this.#url(spec), {
          method: spec.method,
          headers: {
            ...this.#baseHeaders(),
            accept: "application/json",
            ...(hasBody ? { "content-type": "application/json" } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(spec.body) } : {}),
          signal,
        });
      } catch (error) {
        const failure = this.#failure(error, spec);
        if (repeatable && attempt < this.#maxRetries && failure instanceof KerbyConnectionError) {
          await sleep(backoffMs(attempt), spec.signal);
          continue;
        }
        throw failure;
      }
      if (response.ok) return response;
      const retryAfter = retryAfterSeconds(response);
      const retryable =
        response.status === 429 || (repeatable && RETRYABLE_STATUSES.has(response.status));
      if (retryable && attempt < this.#maxRetries && (retryAfter ?? 0) <= MAX_RETRY_WAIT_SECONDS) {
        await response.body?.cancel();
        await sleep(retryAfter === undefined ? backoffMs(attempt) : retryAfter * 1000, spec.signal);
        continue;
      }
      throw await this.#apiError(response, spec);
    }
  }

  async #apiError(
    response: Response,
    spec: Pick<RequestSpec, "method" | "path">,
  ): Promise<KerbyApiError> {
    let code = `http_${response.status}`;
    let message = response.statusText || `HTTP ${response.status}`;
    let problems: unknown;
    const text = await response.text().catch(() => "");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // A proxy's HTML or plain text page: keep its start, it names the proxy.
    }
    const body = ApiErrorBodySchema.safeParse(json);
    if (body.success) {
      ({ code, message, problems } = body.data.error);
    } else if (text) message = text.slice(0, 200);
    return new KerbyApiError({
      status: response.status,
      code,
      message,
      method: spec.method,
      path: spec.path,
      problems,
      retryAfterSeconds: retryAfterSeconds(response),
    });
  }
}

/** 0.5 s, 1 s, 2 s ..., with jitter, so many clients that failed together do not return together. */
const backoffMs = (attempt: number): number => 500 * 2 ** attempt * (0.5 + Math.random() / 2);

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
