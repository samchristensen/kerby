import {
  type ListAvailableToolsResponse,
  ListAvailableToolsResponseSchema,
} from "@kerby/contracts/tenant";
import type { Transport } from "../http.ts";

export class Tools {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /** Lists the enabled tools the caller's integration may name (every one for an admin): `GET /v1/tools`. Needs the `conversations` scope. */
  list(options?: { signal?: AbortSignal }): Promise<ListAvailableToolsResponse> {
    return this.#http.request({
      method: "GET",
      path: "/v1/tools",
      signal: options?.signal,
      schema: ListAvailableToolsResponseSchema,
    });
  }
}
