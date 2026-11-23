// Prompts (ADR 0017): named, versioned instructions. `/v1/prompts*`, all of them need the `admin` scope.

import type {
  ListPromptsQuery,
  Prompt,
  PromptSummary,
  PromptVersion,
  PromptVersionSummary,
  RenderedPrompt,
} from "@kerby/contracts/tenant";
import {
  type CreatePromptRequestSchema,
  ListPromptsResponseSchema,
  PromptSchema,
  PromptVersionSchema,
  PromptVersionSummarySchema,
  type PublishPromptRequestSchema,
  RenderedPromptSchema,
  type RenderPromptRequestSchema,
  type SaveDraftRequestSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { segment, type Transport } from "../http.ts";

type RequestOptions = { signal?: AbortSignal };

export type CreatePromptInput = z.input<typeof CreatePromptRequestSchema>;
export type SaveDraftInput = z.input<typeof SaveDraftRequestSchema>;
export type PublishPromptInput = z.input<typeof PublishPromptRequestSchema>;
export type PromptVariableValues = z.input<typeof RenderPromptRequestSchema>["variables"];

/** A version in a URL: its number, or a label (`production`, `latest`). */
export type PromptVersionRef = number | string;

export class Prompts {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * Lists every prompt of the tenant, by name, optionally of one kind: `GET /v1/prompts`.
   * Needs the `admin` scope. Not paged: at most 1 000 prompts.
   */
  async list(options: ListPromptsQuery & RequestOptions = {}): Promise<PromptSummary[]> {
    const { prompts } = await this.#http.request({
      method: "GET",
      path: "/v1/prompts",
      query: { kind: options.kind },
      signal: options.signal,
      schema: ListPromptsResponseSchema,
    });
    return prompts;
  }

  /**
   * Creates a prompt with an empty draft, or the draft given (same kind): `POST /v1/prompts`.
   * Needs the `admin` scope. Errors: `name_taken`, `prompt_limit`.
   */
  create(input: CreatePromptInput, options: RequestOptions = {}): Promise<Prompt> {
    return this.#http.request({
      method: "POST",
      path: "/v1/prompts",
      body: input,
      signal: options.signal,
      schema: PromptSchema,
    });
  }

  /**
   * Reads a prompt with its draft, `draftRevision` and every version (newest first, no bodies):
   * `GET /v1/prompts/:name`. Needs the `admin` scope.
   */
  get(name: string, options: RequestOptions = {}): Promise<Prompt> {
    return this.#http.request({
      method: "GET",
      path: `/v1/prompts/${segment(name)}`,
      signal: options.signal,
      schema: PromptSchema,
    });
  }

  /**
   * Renames a prompt that has no published version yet: `PATCH /v1/prompts/:name`.
   * Needs the `admin` scope. Errors: `name_taken`, `prompt_published`.
   */
  rename(name: string, newName: string, options: RequestOptions = {}): Promise<Prompt> {
    return this.#http.request({
      method: "PATCH",
      path: `/v1/prompts/${segment(name)}`,
      body: { name: newName },
      signal: options.signal,
      schema: PromptSchema,
    });
  }

  /** Deletes a prompt and its versions: `DELETE /v1/prompts/:name`. Needs the `admin` scope. */
  delete(name: string, options: RequestOptions = {}): Promise<void> {
    return this.#http.send({
      method: "DELETE",
      path: `/v1/prompts/${segment(name)}`,
      signal: options.signal,
    });
  }

  /**
   * Replaces the draft: `PUT /v1/prompts/:name/draft`. Needs the `admin` scope.
   * `revision` is the `draftRevision` the caller started from; a different current one is
   * 409 `draft_conflict` (re-read, merge, save again). Returns the prompt with its new revision.
   */
  saveDraft(name: string, input: SaveDraftInput, options: RequestOptions = {}): Promise<Prompt> {
    return this.#http.request({
      method: "PUT",
      path: `/v1/prompts/${segment(name)}/draft`,
      body: input,
      signal: options.signal,
      schema: PromptSchema,
    });
  }

  /**
   * Publishes the draft at `revision` as the next version: `POST /v1/prompts/:name/versions`.
   * Needs the `admin` scope. Errors: `draft_conflict` (the draft moved past `revision`),
   * `unchanged` (the draft equals the latest version), `not_publishable`.
   */
  publish(
    name: string,
    input: PublishPromptInput,
    options: RequestOptions = {},
  ): Promise<PromptVersionSummary> {
    return this.#http.request({
      method: "POST",
      path: `/v1/prompts/${segment(name)}/versions`,
      body: input,
      signal: options.signal,
      schema: PromptVersionSummarySchema,
    });
  }

  /**
   * Reads one published version by number or label: `GET /v1/prompts/:name/versions/:version`.
   * Needs the `admin` scope.
   */
  getVersion(
    name: string,
    version: PromptVersionRef,
    options: RequestOptions = {},
  ): Promise<PromptVersion> {
    return this.#http.request({
      method: "GET",
      path: `/v1/prompts/${segment(name)}/versions/${segment(version)}`,
      signal: options.signal,
      schema: PromptVersionSchema,
    });
  }

  /**
   * Fills a chat prompt's variables in: `POST /v1/prompts/:name/versions/:version/render`.
   * Needs the `admin` scope. Errors: `wrong_kind` for a decision prompt.
   */
  render(
    name: string,
    version: PromptVersionRef,
    variables: PromptVariableValues = {},
    options: RequestOptions = {},
  ): Promise<RenderedPrompt> {
    return this.#http.request({
      method: "POST",
      path: `/v1/prompts/${segment(name)}/versions/${segment(version)}/render`,
      body: { variables },
      signal: options.signal,
      schema: RenderedPromptSchema,
    });
  }

  /**
   * Points a label at a version: `PUT /v1/prompts/:name/labels/:label`. Needs the `admin` scope.
   * `latest` cannot be set.
   */
  setLabel(
    name: string,
    label: string,
    version: number,
    options: RequestOptions = {},
  ): Promise<Prompt> {
    return this.#http.request({
      method: "PUT",
      path: `/v1/prompts/${segment(name)}/labels/${segment(label)}`,
      body: { version },
      signal: options.signal,
      schema: PromptSchema,
    });
  }

  /** Removes a label: `DELETE /v1/prompts/:name/labels/:label`. Needs the `admin` scope. */
  removeLabel(name: string, label: string, options: RequestOptions = {}): Promise<void> {
    return this.#http.send({
      method: "DELETE",
      path: `/v1/prompts/${segment(name)}/labels/${segment(label)}`,
      signal: options.signal,
    });
  }
}
