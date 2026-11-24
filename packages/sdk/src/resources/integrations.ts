import {
  type ListIntegrationsResponse,
  ListIntegrationsResponseSchema,
  type ToolGrants,
  ToolGrantsSchema,
} from "@kerby/contracts/tenant";
import { segment, type Transport } from "../http.ts";

export class Integrations {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /** Lists the tenant's live integrations: `GET /v1/integrations`. Needs the `admin` scope. */
  list(options?: { signal?: AbortSignal }): Promise<ListIntegrationsResponse> {
    return this.#http.request({
      method: "GET",
      path: "/v1/integrations",
      signal: options?.signal,
      schema: ListIntegrationsResponseSchema,
    });
  }

  /** Reads the tool patterns an integration may use: `GET /v1/integrations/:id/tools`. Needs the `admin` scope. */
  getToolGrants(id: string, options?: { signal?: AbortSignal }): Promise<ToolGrants> {
    return this.#http.request({
      method: "GET",
      path: `/v1/integrations/${segment(id)}/tools`,
      signal: options?.signal,
      schema: ToolGrantsSchema,
    });
  }

  /**
   * Replaces the tool patterns an integration may use: `PUT /v1/integrations/:id/tools`. Needs the `admin` scope.
   * Each pattern must name a server; a single tool must be enabled.
   */
  setToolGrants(
    id: string,
    grants: ToolGrants,
    options?: { signal?: AbortSignal },
  ): Promise<ToolGrants> {
    return this.#http.request({
      method: "PUT",
      path: `/v1/integrations/${segment(id)}/tools`,
      body: grants,
      signal: options?.signal,
      schema: ToolGrantsSchema,
    });
  }
}
