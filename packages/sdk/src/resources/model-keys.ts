import {
  type ListModelKeysResponse,
  ListModelKeysResponseSchema,
  type PutModelKeyRequestSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { segment, type Transport } from "../http.ts";

export type PutModelKeyInput = z.input<typeof PutModelKeyRequestSchema>;

export class ModelKeys {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /** Lists which providers have a stored key and since when (never the key): `GET /v1/model-keys`. Needs the `admin` scope. */
  list(options?: { signal?: AbortSignal }): Promise<ListModelKeysResponse> {
    return this.#http.request({
      method: "GET",
      path: "/v1/model-keys",
      signal: options?.signal,
      schema: ListModelKeysResponseSchema,
    });
  }

  /**
   * Stores or replaces a provider's key: `PUT /v1/model-keys/:provider`. Needs the `admin` scope.
   * Errors: 400 `unknown_provider`; 409 `model_key_limit`.
   */
  put(
    provider: string,
    apiKey: PutModelKeyInput["apiKey"],
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const body: PutModelKeyInput = { apiKey };
    return this.#http.send({
      method: "PUT",
      path: `/v1/model-keys/${segment(provider)}`,
      body,
      signal: options?.signal,
    });
  }

  /** Removes a provider's key: `DELETE /v1/model-keys/:provider`. Needs the `admin` scope. 404 `not_found` when none is stored. */
  delete(provider: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this.#http.send({
      method: "DELETE",
      path: `/v1/model-keys/${segment(provider)}`,
      signal: options?.signal,
    });
  }
}
