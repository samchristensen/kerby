import {
  type Judgment,
  JudgmentSchema,
  type SubmitJudgmentRequestSchema,
  SubmitJudgmentResponseSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { KerbyJudgmentError } from "../errors.ts";
import { segment, type Transport } from "../http.ts";
import { pollUntil, type WaitOptions } from "../wait.ts";

/** The questions and model written out, or `{ state, prompt }` naming a published decision prompt that holds them. */
export type SubmitJudgmentInput = z.input<typeof SubmitJudgmentRequestSchema>;
type Options = { signal?: AbortSignal };

export type AnsweredJudgment = Extract<Judgment, { status: "answered" }>;
/** A judgment that is decided one way or the other: everything but `pending` and `running`. */
export type FinishedJudgment = Exclude<Judgment, { status: "pending" | "running" }>;

const DEFAULT_JUDGE_TIMEOUT_MS = 300_000;

export class Judgments {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * Ask typed questions about some state (`POST /v1/judgments`, 202). Returns the judgment's id at once; a worker
   * answers it. Needs the `judgments` scope and the tenant's key for the judgment provider.
   */
  submit(input: SubmitJudgmentInput, options: Options = {}) {
    return this.#http.request({
      method: "POST",
      path: "/v1/judgments",
      body: input,
      schema: SubmitJudgmentResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Read a judgment (`GET /v1/judgments/:id`). `status` is `pending` or `running` (ask again), `answered` (with one
   * answer per question), `refused` (the provider rejected it; posting it again gets the same result) or `failed`
   * (an outage; posting it again may succeed).
   */
  get(id: string, options: Options = {}) {
    return this.#http.request({
      method: "GET",
      path: `/v1/judgments/${segment(id)}`,
      schema: JudgmentSchema,
      signal: options.signal,
    });
  }

  /**
   * Wait until the judgment is decided and return it: `answered`, `refused` or `failed`. Throws `KerbyTimeoutError`
   * after `timeoutMs` (default 5 minutes); the judgment keeps running.
   */
  wait(id: string, options: WaitOptions = {}): Promise<FinishedJudgment> {
    const poll: Options = options.signal ? { signal: options.signal } : {};
    return pollUntil(
      `judgment ${id}`,
      () => this.get(id, poll),
      (judgment): judgment is FinishedJudgment =>
        judgment.status !== "pending" && judgment.status !== "running",
      { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS },
    ) as Promise<FinishedJudgment>;
  }

  /** Submit, wait, and return the answered judgment. Throws `KerbyJudgmentError` when it is `refused` or `failed`. */
  async judge(input: SubmitJudgmentInput, options: WaitOptions = {}): Promise<AnsweredJudgment> {
    const poll: Options = options.signal ? { signal: options.signal } : {};
    const { id } = await this.submit(input, poll);
    const judgment = await this.wait(id, options);
    if (judgment.status !== "answered") throw new KerbyJudgmentError(judgment);
    return judgment;
  }
}
