import {
  type SearchRequestSchema,
  SearchResponseSchema,
  SearchSettingsSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import type { Transport } from "../http.ts";

export type SearchInput = z.input<typeof SearchRequestSchema>;
type Options = { signal?: AbortSignal };

export class Search {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /**
   * Find conversations by what was said (`POST /v1/search`): plain words, `"quoted phrases"`, `or`, `-excluded`. At most
   * one hit per conversation, best first. Needs the `conversations` scope and sees only what the key's integration
   * may see. `mode` says whether meaning (`hybrid`) or only words (`keyword`) matched; `notice` says why a tenant
   * with an embedding model got keyword results.
   */
  query(input: SearchInput, options: Options = {}) {
    return this.#http.request({
      method: "POST",
      path: "/v1/search",
      body: input,
      schema: SearchResponseSchema,
      signal: options.signal,
    });
  }

  /** The search settings and how much of the tenant's chats is indexed (`GET /v1/search/settings`). Needs the `admin` scope. */
  getSettings(options: Options = {}) {
    return this.#http.request({
      method: "GET",
      path: "/v1/search/settings",
      schema: SearchSettingsSchema,
      signal: options.signal,
    });
  }

  /**
   * Choose the embedding model, `<provider>/<modelId>`, or `null` for keyword search only (`PUT /v1/search/settings`).
   * The tenant must hold a key for the provider. Needs the `admin` scope.
   */
  putSettings(embeddingModel: string | null, options: Options = {}) {
    return this.#http.request({
      method: "PUT",
      path: "/v1/search/settings",
      body: { embeddingModel },
      schema: SearchSettingsSchema,
      signal: options.signal,
    });
  }
}
