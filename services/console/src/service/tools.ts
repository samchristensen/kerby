// The tenant's tools (ADR 0022): remote MCP servers, the tools each lists, which integrations may use them, and the
// tools a person may name on a chat. Everything goes through the api with the person's session token, as an admin.
import {
  CreateToolServerRequestSchema,
  FinishToolServerOAuthRequestSchema,
  ListAvailableToolsResponseSchema,
  ListIntegrationsResponseSchema,
  ListToolServersResponseSchema,
  PutToolCredentialRequestSchema,
  StartToolServerOAuthResponseSchema,
  ToolGrantsSchema,
  ToolNameSchema,
  type ToolServerAuth,
  ToolServerSchema,
  ToolServerSlugSchema,
  UpdateToolRequestSchema,
  UpdateToolServerRequestSchema,
} from "@kerby/contracts";
import { z } from "zod";
import type {
  ChatAccess,
  ConsoleDeps,
  ConsoleService,
  FormFailure,
  ToolServerView,
} from "../types/index.ts";
import { apiError, apiFault, toolsOf } from "./api.ts";
import { parseForm, refuse } from "./forms.ts";

/** What the person is told when the api refuses a tools request; a fault on our side is thrown instead. */
async function refusal(response: Response): Promise<FormFailure> {
  const { code, message } = await apiError(response);
  switch (code) {
    case "tool_server_exists":
      return { ok: false, fields: { slug: "A server already has this name. Choose another." } };
    case "not_found":
      return refuse("This server, tool or integration no longer exists. Reload the page.");
    case "rate_limited":
      return refuse("Too many requests. Try again in a moment.");
    case "tool_server_limit":
    case "builtin_tool_server":
    case "tool_not_usable":
    // The tool's definition changed since the page was rendered: reload and review it.
    case "definition_changed":
    case "unknown_tool":
    case "invalid_request":
    // Connecting with OAuth: each says what happened and what to do (connect again, set CONSOLE_PUBLIC_URL, ...).
    case "oauth_not_configured":
    case "oauth_failed":
    case "oauth_state_unknown":
    case "oauth_state_expired":
    case "oauth_issuer_mismatch":
    case "oauth_denied":
      return refuse(message ?? "The request was refused.");
  }
  throw apiFault("tools", response.status, code);
}

/**
 * A form's auth fields: `auth` is `none`, `header` or `oauth`; `header` names the header, `credential` is its value;
 * `scope` is what an OAuth server is asked for (blank: what the server names).
 */
const AuthForm = z.object({
  auth: z
    .enum(["none", "header", "oauth"], "choose no authentication, a header or OAuth")
    .default("none"),
  header: z.string().trim().default(""),
  credential: z.string().default(""),
  scope: z.string().trim().default(""),
});

const CreateForm = AuthForm.extend({
  slug: z.string().trim().default(""),
  url: z.string().trim().default(""),
});

const UpdateForm = AuthForm.extend({ url: z.string().trim().default("") });

/** Form field names for a request schema's issue paths (`auth.header` is typed in `header`, `auth.scope` in `scope`). */
function requestFailure(error: z.ZodError): FormFailure {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const [first, second] = issue.path;
    const field =
      first === "auth"
        ? second === "header" || second === "scope"
          ? second
          : "auth"
        : String(first ?? "form");
    fields[field] ??= issue.message.charAt(0).toUpperCase() + issue.message.slice(1);
  }
  return { ok: false, fields };
}

function authOf(form: z.output<typeof AuthForm>): ToolServerAuth {
  if (form.auth === "header") return { kind: "header", header: form.header };
  if (form.auth === "oauth")
    return form.scope === "" ? { kind: "oauth" } : { kind: "oauth", scope: form.scope };
  return { kind: "none" };
}

const serverPath = (slug: string): string | undefined =>
  ToolServerSlugSchema.safeParse(slug).success ? `/v1/tool-servers/${slug}` : undefined;

const GONE = refuse("This server no longer exists. Reload the page.");

type Tools = Pick<
  ConsoleService,
  | "toolServers"
  | "toolServer"
  | "createToolServer"
  | "updateToolServer"
  | "replaceToolCredential"
  | "syncToolServer"
  | "deleteToolServer"
  | "updateTool"
  | "availableTools"
  | "integrationTools"
  | "setIntegrationTools"
  | "connectToolServer"
  | "finishToolServerOAuth"
>;

export function createTools(deps: ConsoleDeps): Tools {
  const { api } = deps;

  /** A successful read's body, or undefined for "not found"; anything else throws. */
  async function read(access: ChatAccess, path: string): Promise<unknown> {
    const response = await api({ method: "GET", path, token: access.token });
    if (response.status === 404) return undefined;
    if (!response.ok)
      throw apiFault("tools read", response.status, (await apiError(response)).code);
    return response.json();
  }

  async function send(
    access: ChatAccess,
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ ok: true; response: Response } | FormFailure> {
    const response = await api({
      method,
      path,
      token: access.token,
      ...(body === undefined ? {} : { body }),
    });
    return response.ok ? { ok: true, response } : refusal(response);
  }

  return {
    async toolServers(access) {
      const body = await read(access, "/v1/tool-servers");
      if (body === undefined) throw new Error("the api has no /v1/tool-servers");
      return ListToolServersResponseSchema.parse(body).servers;
    },

    async toolServer(access, slug) {
      const path = serverPath(slug);
      if (!path) return undefined;
      const [server, integrations] = await Promise.all([
        read(access, path),
        read(access, "/v1/integrations"),
      ]);
      if (server === undefined) return undefined;
      const names = new Map(
        ListIntegrationsResponseSchema.parse(integrations).integrations.map((i) => [i.id, i.name]),
      );
      const parsed = ToolServerSchema.parse(server);
      const view: ToolServerView = {
        ...parsed,
        // An integration deleted since the grant was read is left out: it can no longer use anything.
        grantedTo: parsed.grantedTo.flatMap((grant) => {
          const name = names.get(grant.integrationId);
          return name === undefined ? [] : [{ ...grant, integrationName: name }];
        }),
      };
      return view;
    },

    async createToolServer(access, form) {
      const parsed = parseForm(CreateForm, form);
      if (!parsed.ok) return parsed;
      const { slug, url, credential } = parsed.data;
      const request = CreateToolServerRequestSchema.safeParse({
        slug,
        url,
        auth: authOf(parsed.data),
        ...(parsed.data.auth === "header" && credential !== "" ? { credential } : {}),
      });
      if (!request.success) return requestFailure(request.error);
      const sent = await send(access, "POST", "/v1/tool-servers", request.data);
      return sent.ok ? { ok: true, slug: request.data.slug } : sent;
    },

    async updateToolServer(access, slug, form) {
      const path = serverPath(slug);
      if (!path) return GONE;
      const parsed = parseForm(UpdateForm, form);
      if (!parsed.ok) return parsed;
      const { url, credential } = parsed.data;
      // A blank credential with header auth keeps the stored one (the api refuses if there is none).
      const request = UpdateToolServerRequestSchema.safeParse({
        url,
        auth: authOf(parsed.data),
        ...(parsed.data.auth === "header" && credential !== "" ? { credential } : {}),
      });
      if (!request.success) return requestFailure(request.error);
      const sent = await send(access, "PATCH", path, request.data);
      return sent.ok ? { ok: true } : sent;
    },

    async replaceToolCredential(access, slug, form) {
      const path = serverPath(slug);
      if (!path) return GONE;
      const parsed = parseForm(PutToolCredentialRequestSchema, form);
      if (!parsed.ok) return parsed;
      const sent = await send(access, "PUT", `${path}/credential`, parsed.data);
      return sent.ok ? { ok: true } : sent;
    },

    async syncToolServer(access, slug) {
      const path = serverPath(slug);
      if (!path) return GONE;
      const sent = await send(access, "POST", `${path}/sync`);
      return sent.ok ? { ok: true } : sent;
    },

    async deleteToolServer(access, slug) {
      const path = serverPath(slug);
      if (!path) return GONE;
      const sent = await send(access, "DELETE", path);
      return sent.ok ? { ok: true } : sent;
    },

    async updateTool(access, slug, name, change) {
      const path = serverPath(slug);
      if (!path || !ToolNameSchema.safeParse(name).success) return GONE;
      const request = UpdateToolRequestSchema.safeParse(change);
      if (!request.success)
        return refuse("Change whether it is enabled, its effect, or accept its definition.");
      const sent = await send(
        access,
        "PATCH",
        `${path}/tools/${encodeURIComponent(name)}`,
        request.data,
      );
      return sent.ok ? { ok: true } : sent;
    },

    async availableTools(access) {
      const body = await read(access, "/v1/tools");
      if (body === undefined) throw new Error("the api has no /v1/tools");
      return ListAvailableToolsResponseSchema.parse(body).tools;
    },

    async integrationTools(access, id) {
      if (!z.uuid().safeParse(id).success) return undefined;
      const body = await read(access, `/v1/integrations/${id}/tools`);
      return body === undefined ? undefined : ToolGrantsSchema.parse(body).tools;
    },

    async setIntegrationTools(access, id, form) {
      if (!z.uuid().safeParse(id).success) {
        return refuse("This integration no longer exists. Reload the page.");
      }
      const request = ToolGrantsSchema.safeParse({ tools: toolsOf(form) });
      if (!request.success)
        return refuse(request.error.issues[0]?.message ?? "Choose fewer tools.");
      const sent = await send(access, "PUT", `/v1/integrations/${id}/tools`, request.data);
      return sent.ok ? { ok: true } : sent;
    },

    async connectToolServer(access, slug) {
      const path = serverPath(slug);
      if (!path) return GONE;
      const sent = await send(access, "POST", `${path}/oauth/start`);
      if (!sent.ok) return sent;
      const { authorizationUrl } = StartToolServerOAuthResponseSchema.parse(
        await sent.response.json(),
      );
      return { ok: true, authorizationUrl };
    },

    async finishToolServerOAuth(access, answer) {
      const request = FinishToolServerOAuthRequestSchema.safeParse({
        state: answer.state,
        ...(answer.iss === undefined ? {} : { iss: answer.iss }),
        ...(answer.code === undefined ? {} : { code: answer.code }),
        ...(answer.error === undefined ? {} : { error: answer.error }),
        ...(answer.error_description === undefined
          ? {}
          : { errorDescription: answer.error_description }),
      });
      if (!request.success)
        return refuse(
          "This page finishes a connection an authorization server answered, and this is not such an answer. Connect again from the server's page.",
        );
      const sent = await send(access, "POST", "/v1/tool-servers/oauth/callback", request.data);
      if (!sent.ok) return sent;
      return { ok: true, slug: ToolServerSchema.parse(await sent.response.json()).slug };
    },
  };
}
