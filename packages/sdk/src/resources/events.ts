import {
  type EventTypePattern,
  type ListEventsResponse,
  ListEventsResponseSchema,
} from "@kerby/contracts/tenant";
import type { Transport } from "../http.ts";

export type ListEventsInput = {
  /** The `next` of a previous response. Without it, from the oldest event kept (30 days). */
  after?: string;
  /** 1 to 500, default 100. */
  limit?: number;
  /** Event types or family wildcards: `["turn.completed"]`, `["turn.*"]`, `["*"]`. */
  types?: readonly EventTypePattern[];
  /** Only this conversation's events. */
  conversationId?: string;
  /** Hold the request open up to this many seconds (0 to 30) until an event arrives: a long poll. */
  wait?: number;
};

export type TailEventsInput = Omit<ListEventsInput, "wait"> & {
  /** Seconds each long poll waits (0 to 30). Default 25. */
  waitSeconds?: number;
  /** Ends the iteration (no error) when aborted. */
  signal?: AbortSignal;
};

/** Time added to a long poll's own wait before the request is given up on. */
const LONG_POLL_SLACK_MS = 15_000;
const DEFAULT_WAIT_SECONDS = 25;

export class Events {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * One page of the event log, oldest first (`GET /v1/events`). Events are thin: ids, `seq` and status, never message
   * text. Persist `next` and pass it as `after` to continue exactly where this page ended. Needs the `events` scope;
   * a key without `tenant` sees only its own integration's events.
   */
  list(
    input: ListEventsInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ListEventsResponse> {
    return this.#http.request({
      method: "GET",
      path: "/v1/events",
      query: input,
      schema: ListEventsResponseSchema,
      signal: options.signal,
      timeoutMs: (input.wait ?? 0) * 1000 + 60_000 + LONG_POLL_SLACK_MS,
    });
  }

  /**
   * Follow the log: yields each non-empty page as it arrives, long polling between them, until `signal` aborts. Save
   * `next` after you handled a page; start again from it with `after`. Delivery to you is at least once across
   * restarts (the page you had not saved is read again), so handle events idempotently by `id`.
   */
  async *tail(input: TailEventsInput = {}): AsyncGenerator<ListEventsResponse> {
    const { signal, waitSeconds = DEFAULT_WAIT_SECONDS, ...query } = input;
    let after = query.after;
    while (!signal?.aborted) {
      let page: ListEventsResponse;
      try {
        page = await this.list(
          { ...query, ...(after ? { after } : {}), wait: waitSeconds },
          signal ? { signal } : {},
        );
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
      after = page.next;
      if (page.events.length > 0) yield page;
    }
  }
}
