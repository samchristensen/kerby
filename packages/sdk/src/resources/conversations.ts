import {
  ConversationSchema,
  type ConversationSummary,
  type CreateConversationRequestSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  type GetConversationResponse,
  GetConversationResponseSchema,
  GetTraceResponseSchema,
  ListConversationsResponseSchema,
  type PostMessageRequestSchema,
  PostMessageResponseSchema,
  type StreamInclude,
  type TraceEntry,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { KerbyConnectionError, KerbyResponseError, KerbyTurnError } from "../errors.ts";
import { segment, sleep, type Transport } from "../http.ts";
import { parseSse, type SseMessage } from "../sse.ts";
import { pollUntil, type WaitOptions } from "../wait.ts";

export type CreateConversationInput = z.input<typeof CreateConversationRequestSchema>;
/** What a message holds: plain text, or content parts (text and blob references). */
export type MessageContent = z.input<typeof PostMessageRequestSchema>["content"];
export type ListConversationsInput = {
  /** 1 to 100, default 30. */
  limit?: number;
  /** A previous page's `nextCursor`. */
  cursor?: string;
  /** Only this end user's conversations (the name given at creation). */
  externalUserId?: string;
};
export type GetTraceInput = {
  /** A previous page's `nextAfter`. */
  after?: number;
  /** 1 to 1000, default 200. */
  limit?: number;
};

type Options = { signal?: AbortSignal };

/** One persisted message with its position in the conversation. */
export type StoredMessage = GetConversationResponse["messages"][number];

/** Whether a conversation is working, and why its latest turn produced no answer. */
export type ConversationStatus = Pick<GetConversationResponse, "busy" | "lastError">;

/** What `ask` returns: the answer, and everything the turn wrote. */
export type Reply = {
  /** The user message's position; the turn answered it. */
  seq: number;
  /** The text of the final assistant message. A turn that only called tools, or was blocked by a guardrail, may have none: then "". */
  text: string;
  /** Every message after `seq`, oldest first: the assistant's messages, and the results of tools it called. */
  messages: StoredMessage[];
};

export type AskOptions = WaitOptions;

export type StreamOptions = {
  /** Resume after this message `seq` (default 0: replay the whole conversation, then go live). */
  after?: number;
  /** `["thinking"]` adds the model's reasoning events; without it they are dropped server side. */
  include?: readonly StreamInclude[];
  /** Ends the iteration (no error) when aborted. */
  signal?: AbortSignal;
  /** Reopen the stream, from the last message seen, when the connection drops. Default true. */
  reconnect?: boolean;
};

const DEFAULT_ASK_TIMEOUT_MS = 600_000;
const MAX_RECONNECT_FAILURES = 5;
/** What the turn being over resolves to in `streamReply`, to tell it from an event. */
const OVER = Symbol("over");

export class Conversations {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * Start a conversation (`POST /v1/conversations`). The tenant must hold a model key for the model's provider
   * (400 `invalid_model` otherwise). Needs the `conversations` scope.
   */
  create(input: CreateConversationInput = {}, options: Options = {}) {
    return this.#http.request({
      method: "POST",
      path: "/v1/conversations",
      body: input,
      schema: ConversationSchema,
      signal: options.signal,
    });
  }

  /**
   * One page of conversations, most recently active first (`GET /v1/conversations`). A key without the `tenant`
   * scope sees only conversations its own integration started.
   */
  list(input: ListConversationsInput = {}, options: Options = {}) {
    return this.#http.request({
      method: "GET",
      path: "/v1/conversations",
      query: input,
      schema: ListConversationsResponseSchema,
      signal: options.signal,
    });
  }

  /** Every conversation, page after page, most recently active first. */
  async *listAll(
    input: Omit<ListConversationsInput, "cursor"> = {},
    options: Options = {},
  ): AsyncGenerator<ConversationSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...input, ...(cursor ? { cursor } : {}) }, options);
      yield* page.conversations;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /**
   * The conversation and one page of its messages, oldest first (`GET /v1/conversations/:id`), with `busy` (a turn is
   * queued or running) and `lastError`. `after` is a message `seq`; `limit` is 1 to 500 (default 100).
   */
  get(id: string, input: { after?: number; limit?: number } = {}, options: Options = {}) {
    return this.#http.request({
      method: "GET",
      path: `/v1/conversations/${segment(id)}`,
      query: input,
      schema: GetConversationResponseSchema,
      signal: options.signal,
    });
  }

  /** Every message after `after` (default: all), oldest first, page after page. */
  async *messages(
    id: string,
    input: { after?: number } = {},
    options: Options = {},
  ): AsyncGenerator<StoredMessage> {
    let after: number | undefined = input.after;
    do {
      const page: GetConversationResponse = await this.get(
        id,
        { ...(after === undefined ? {} : { after }), limit: 500 },
        options,
      );
      yield* page.messages;
      after = page.nextAfter ?? undefined;
    } while (after !== undefined);
  }

  /** Whether a turn is queued or running, and why the latest turn produced no answer (cleared by the next message). */
  async status(id: string, options: Options = {}): Promise<ConversationStatus> {
    const { busy, lastError } = await this.get(id, { limit: 1 }, options);
    return { busy, lastError };
  }

  /**
   * Add a user message and start the turn that answers it (`POST /v1/conversations/:id/messages`, 202). Returns at once
   * with the message's `seq`; the answer arrives later (see `ask`, `stream`, `waitForTurn`, or subscribe to events).
   * 409 `conversation_busy` while a turn is queued or running: one turn at a time per conversation.
   */
  post(id: string, content: MessageContent, options: Options = {}) {
    return this.#http.request({
      method: "POST",
      path: `/v1/conversations/${segment(id)}/messages`,
      body: { content },
      schema: PostMessageResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Wait until no turn is queued or running, and return the conversation's status. Polls `GET /v1/conversations/:id`.
   * Throws `KerbyTimeoutError` after `timeoutMs` (default 10 minutes); the turn keeps running.
   */
  waitForTurn(id: string, options: AskOptions = {}): Promise<ConversationStatus> {
    const poll: Options = options.signal ? { signal: options.signal } : {};
    return pollUntil(
      `the turn in conversation ${id}`,
      () => this.status(id, poll),
      (status) => !status.busy,
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS },
    );
  }

  /**
   * Post a message and wait for the answer: the whole request/response exchange in one call. Throws `KerbyTurnError`
   * when the turn ends without an answer (no model key, provider refusal, retries exhausted) and `KerbyTimeoutError`
   * after `timeoutMs` (default 10 minutes; the turn keeps running).
   *
   * A message a guardrail blocks is not an error here: the refusal Kerby writes comes back as the reply. To tell
   * blocked from answered, read the `turn.blocked` event.
   */
  async ask(id: string, content: MessageContent, options: AskOptions = {}): Promise<Reply> {
    const request: Options = options.signal ? { signal: options.signal } : {};
    const { seq } = await this.post(id, content, request);
    const status = await this.waitForTurn(id, options);
    if (status.lastError !== null) throw new KerbyTurnError(status.lastError, id, seq);
    const messages: StoredMessage[] = [];
    for await (const message of this.messages(id, { after: seq }, request)) messages.push(message);
    const final = messages.findLast((stored) => stored.message.role === "assistant");
    const text =
      final?.message.role === "assistant"
        ? final.message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("")
        : "";
    return { seq, text, messages };
  }

  /** The trace of the conversation's runs, in recorded order (`GET /v1/conversations/:id/trace`): complete events with reasoning and tool results. */
  trace(id: string, input: GetTraceInput = {}, options: Options = {}) {
    return this.#http.request({
      method: "GET",
      path: `/v1/conversations/${segment(id)}/trace`,
      query: input,
      schema: GetTraceResponseSchema,
      signal: options.signal,
    });
  }

  /** Every trace entry, page after page. */
  async *traceAll(
    id: string,
    input: Omit<GetTraceInput, "after"> = {},
    options: Options = {},
  ): AsyncGenerator<TraceEntry> {
    let after: number | undefined;
    do {
      const page = await this.trace(
        id,
        { ...input, ...(after === undefined ? {} : { after }) },
        options,
      );
      yield* page.events;
      after = page.nextAfter ?? undefined;
    } while (after !== undefined);
  }

  /**
   * Live events of one conversation (`GET /v1/conversations/:id/events`, server-sent events): first every persisted
   * message after `after` as a `message_end` event, then what runs report as it happens (`text_delta`,
   * `tool_start`, `tool_end`, `run_end`, ...). The stream never ends by itself: stop at the `run_end` of your turn, or
   * abort `signal`.
   *
   * - Persisted `message_end` events are replayed after a reconnect and are the record; live events (deltas) are not
   *   replayed, so a reconnect can lose some.
   * - A `run_end` that happened before you connected is not replayed. To follow a turn live, open the stream (from the
   *   last `seq` you hold) BEFORE you `post`; to just get the answer, use `ask`.
   * - Needs the `conversations` scope; a tenant has a cap on open streams (429 `rate_limited` over it).
   */
  async *stream(id: string, options: StreamOptions = {}): AsyncGenerator<EventEnvelope> {
    const path = `/v1/conversations/${segment(id)}/events`;
    const reconnect = options.reconnect ?? true;
    const include = options.include?.length ? options.include : undefined;
    let lastId = options.after ?? 0;
    let failures = 0;
    for (;;) {
      let body: ReadableStream<Uint8Array>;
      try {
        body = await this.#http.openStream({
          path,
          ...(include ? { query: { include } } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(lastId > 0 ? { headers: { "last-event-id": String(lastId) } } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) return;
        if (
          !reconnect ||
          !(error instanceof KerbyConnectionError) ||
          ++failures > MAX_RECONNECT_FAILURES
        )
          throw error;
        await sleep(Math.min(500 * 2 ** failures, 8000), options.signal).catch(() => {});
        continue;
      }
      const events = parseSse(body);
      try {
        for (;;) {
          let next: IteratorResult<SseMessage>;
          try {
            next = await events.next();
          } catch (error) {
            if (options.signal?.aborted) return;
            if (!reconnect || ++failures > MAX_RECONNECT_FAILURES)
              throw new KerbyConnectionError(`the event stream of conversation ${id} dropped`, {
                cause: error,
              });
            break;
          }
          if (next.done) break;
          failures = 0;
          const message = next.value;
          let envelope: EventEnvelope;
          try {
            envelope = this.#http.parse(EventEnvelopeSchema, JSON.parse(message.data), {
              method: "GET",
              path,
            });
          } catch (error) {
            if (error instanceof KerbyResponseError) throw error;
            throw new KerbyResponseError(`GET ${path} sent an event that is not JSON`, "GET", path);
          }
          if (message.id !== undefined) lastId = Number(message.id);
          yield envelope;
        }
      } finally {
        await events.return(undefined);
      }
      if (options.signal?.aborted || !reconnect) return;
      // The server ended the stream (it rechecks the key while open); a revoked key fails the reopen with 401.
      await sleep(1000, options.signal).catch(() => {});
      if (options.signal?.aborted) return;
    }
  }

  /**
   * Post a message and stream the turn that answers it: the race-free way to show an answer as it is written. Yields
   * what `stream` yields for this turn only (`text_delta`, `tool_start`, `tool_end`, each persisted `message_end`) and
   * ends after its `run_end`.
   *
   * If the turn is over before the stream said so (it connected late and missed the live `run_end`), the messages not
   * yet yielded come as `message_end` events and the iteration ends without a `run_end`; call `status` for
   * `lastError`. Breaking out of the loop, or aborting `signal`, stops the stream but not the turn.
   */
  async *streamReply(
    id: string,
    content: MessageContent,
    options: Pick<StreamOptions, "include" | "signal"> = {},
  ): AsyncGenerator<EventEnvelope> {
    const request: Options = options.signal ? { signal: options.signal } : {};
    const { seq } = await this.post(id, content, request);
    const inner = new AbortController();
    const stop = () => inner.abort();
    options.signal?.addEventListener("abort", stop, { once: true });
    const events = this.stream(id, {
      after: seq,
      ...(options.include ? { include: options.include } : {}),
      signal: inner.signal,
    });
    // Safety net for the live `run_end` a late connection misses: the turn being over ends the iteration too.
    const over = this.waitForTurn(id, { signal: inner.signal }).then(
      (): typeof OVER => OVER,
      () => new Promise<never>(() => {}),
    );
    let lastMessage = seq;
    try {
      for (;;) {
        const next = events.next();
        const got = await Promise.race([next, over]);
        if (got === OVER) {
          inner.abort();
          next.catch(() => {});
          for await (const stored of this.messages(id, { after: lastMessage }, request))
            yield {
              v: 1,
              conversationId: id,
              runId: "",
              seq: stored.seq,
              at: stored.createdAt,
              event: { type: "message_end", message: stored.message },
            };
          return;
        }
        if (got.done) return;
        const envelope = got.value;
        if (envelope.event.type === "message_end")
          lastMessage = Math.max(lastMessage, envelope.seq);
        yield envelope;
        if (envelope.event.type === "run_end") return;
      }
    } finally {
      options.signal?.removeEventListener("abort", stop);
      inner.abort();
    }
  }
}
