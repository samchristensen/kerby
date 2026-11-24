import {
  type CreateToolServerRequestSchema,
  type FinishToolServerOAuthRequestSchema,
  type ListToolServersResponse,
  ListToolServersResponseSchema,
  type PutToolCredentialRequestSchema,
  type StartToolServerOAuthResponse,
  StartToolServerOAuthResponseSchema,
  type Tool,
  ToolSchema,
  type ToolServer,
  ToolServerSchema,
  type UpdateToolRequestSchema,
  type UpdateToolServerRequestSchema,
} from "@kerby/contracts/tenant";
import type { z } from "zod";
import { segment, type Transport } from "../http.ts";

export type CreateToolServerInput = z.input<typeof CreateToolServerRequestSchema>;
export type UpdateToolServerInput = z.input<typeof UpdateToolServerRequestSchema>;
export type FinishToolServerOAuthInput = z.input<typeof FinishToolServerOAuthRequestSchema>;
export type UpdateToolInput = z.input<typeof UpdateToolRequestSchema>;

export class ToolServers {
  readonly #http: Transport;

  constructor(http: Transport) {
    this.#http = http;
  }

  /** Lists the tenant's tool servers, the built-in `kerby` first: `GET /v1/tool-servers`. Needs the `admin` scope. */
  list(options?: { signal?: AbortSignal }): Promise<ListToolServersResponse> {
    return this.#http.request({
      method: "GET",
      path: "/v1/tool-servers",
      signal: options?.signal,
      schema: ListToolServersResponseSchema,
    });
  }

  /**
   * Registers a remote MCP server; a worker then lists its tools (status `syncing`): `POST /v1/tool-servers`. Needs the
   * `admin` scope. Errors: 409 `tool_server_exists`, 409 `tool_server_limit`.
   */
  create(input: CreateToolServerInput, options?: { signal?: AbortSignal }): Promise<ToolServer> {
    return this.#http.request({
      method: "POST",
      path: "/v1/tool-servers",
      body: input,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /** Reads a server with its tools and grants: `GET /v1/tool-servers/:slug`. Needs the `admin` scope. */
  get(slug: string, options?: { signal?: AbortSignal }): Promise<ToolServer> {
    return this.#http.request({
      method: "GET",
      path: `/v1/tool-servers/${segment(slug)}`,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /**
   * Changes a server's URL or auth and lists its tools again (202): `PATCH /v1/tool-servers/:slug`. Needs the `admin`
   * scope. Error: 400 `builtin_tool_server` for `kerby`.
   */
  update(
    slug: string,
    input: UpdateToolServerInput,
    options?: { signal?: AbortSignal },
  ): Promise<ToolServer> {
    return this.#http.request({
      method: "PATCH",
      path: `/v1/tool-servers/${segment(slug)}`,
      body: input,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /** Deletes a server with its tools and grants: `DELETE /v1/tool-servers/:slug`. Needs the `admin` scope. */
  delete(slug: string, options?: { signal?: AbortSignal }): Promise<void> {
    return this.#http.send({
      method: "DELETE",
      path: `/v1/tool-servers/${segment(slug)}`,
      signal: options?.signal,
    });
  }

  /**
   * Replaces a `header`-auth server's credential and lists its tools again (202):
   * `PUT /v1/tool-servers/:slug/credential`. Needs the `admin` scope. The value is never returned.
   */
  putCredential(
    slug: string,
    value: z.input<typeof PutToolCredentialRequestSchema>["value"],
    options?: { signal?: AbortSignal },
  ): Promise<ToolServer> {
    const body: z.input<typeof PutToolCredentialRequestSchema> = { value };
    return this.#http.request({
      method: "PUT",
      path: `/v1/tool-servers/${segment(slug)}/credential`,
      body,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /** Lists the server's tools again (202): `POST /v1/tool-servers/:slug/sync`. Needs the `admin` scope. */
  sync(slug: string, options?: { signal?: AbortSignal }): Promise<ToolServer> {
    return this.#http.request({
      method: "POST",
      path: `/v1/tool-servers/${segment(slug)}/sync`,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /**
   * Begins connecting an `oauth` server; returns where to send the person's browser:
   * `POST /v1/tool-servers/:slug/oauth/start`. Needs the `admin` scope. Errors: `oauth_not_configured`, `oauth_failed`.
   */
  startOAuth(
    slug: string,
    options?: { signal?: AbortSignal },
  ): Promise<StartToolServerOAuthResponse> {
    return this.#http.request({
      method: "POST",
      path: `/v1/tool-servers/${segment(slug)}/oauth/start`,
      signal: options?.signal,
      schema: StartToolServerOAuthResponseSchema,
    });
  }

  /**
   * Completes the OAuth connection with what the authorization server sent back (`state`, `iss`, `code` or `error`):
   * `POST /v1/tool-servers/oauth/callback`. Needs the `admin` scope. Errors: `oauth_state_unknown`,
   * `oauth_state_expired`, `oauth_issuer_mismatch`, `oauth_denied`, `oauth_failed`.
   */
  finishOAuth(
    input: FinishToolServerOAuthInput,
    options?: { signal?: AbortSignal },
  ): Promise<ToolServer> {
    return this.#http.request({
      method: "POST",
      path: "/v1/tool-servers/oauth/callback",
      body: input,
      signal: options?.signal,
      schema: ToolServerSchema,
    });
  }

  /**
   * Enables or disables one tool, sets its effect, or pins the definition the server lists now:
   * `PATCH /v1/tool-servers/:slug/tools/:name`. Needs the `admin` scope. Errors: 409 `definition_changed` (the server
   * lists another definition than `expectedDefinition`, the `listedHash` shown), 400 `tool_not_usable`.
   */
  updateTool(
    slug: string,
    name: string,
    input: UpdateToolInput,
    options?: { signal?: AbortSignal },
  ): Promise<Tool> {
    return this.#http.request({
      method: "PATCH",
      path: `/v1/tool-servers/${segment(slug)}/tools/${segment(name)}`,
      body: input,
      signal: options?.signal,
      schema: ToolSchema,
    });
  }
}
