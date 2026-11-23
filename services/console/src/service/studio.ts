// The Studio (ADR 0017): the tenant's chat prompts and decision models, edited, published, labelled and tried out from
// the console. Everything lives in the tenant's database behind the api's `/v1/prompts` routes, which the console calls
// with the person's session token, like a chat. The playgrounds start a real conversation (`studio:<userId>`) or a real
// judgment, on the tenant's keys and counted like any other.
import {
  CreateConversationRequestSchema,
  CreatePromptRequestSchema,
  JudgmentSchema,
  LATEST_LABEL,
  ListPromptsResponseSchema,
  PromptKindSchema,
  PromptLabelSchema,
  PromptNameSchema,
  PromptSchema,
  PromptVersionParamSchema,
  PromptVersionSchema,
  PromptVersionSummarySchema,
  PublishPromptRequestSchema,
  SaveDraftRequestSchema,
  SetPromptLabelRequestSchema,
  SubmitJudgmentRequestSchema,
} from "@kerby/contracts";
import { InvalidVariablesError, renderTemplate, templateVariables } from "@kerby/prompts";
import { z } from "zod";
import type { ChatAccess, ConsoleDeps, ConsoleService, StudioFailure } from "../types/index.ts";
import { apiError, apiFault, missingModelKey, STUDIO_USER_PREFIX, variableValues } from "./api.ts";
import { parseForm, refuse } from "./forms.ts";

/** A playground's `source`: the saved draft, or else a published version by number or label. */
const DRAFT_SOURCE = "draft";

const CreateForm = z.object({
  name: z.string().trim().pipe(PromptNameSchema),
  kind: PromptKindSchema.catch("chat"),
});

const RenameForm = z.object({ name: z.string().trim().pipe(PromptNameSchema) });

const PublishForm = z.object({
  note: z.string().trim().max(1_000, "at most 1 000 characters").default(""),
});

const LabelForm = z.object({
  label: z
    .string()
    .trim()
    .pipe(PromptLabelSchema)
    .refine(
      (label) => label !== LATEST_LABEL,
      "latest always points at the newest version: choose another label",
    ),
  version: z.coerce.number<unknown>().int().min(1, "choose a version"),
});

const PlaygroundForm = z.object({ source: z.string().trim().default(DRAFT_SOURCE) });

const DecisionForm = PlaygroundForm.extend({
  state: z.string().max(1_000_000, "at most 1 000 000 characters").default(""),
});

/**
 * What the person is told when the api refuses a Studio request. A fault on our side (5xx, a bad credential, a
 * request this code should never have made) is thrown instead.
 */
async function refusal(response: Response): Promise<StudioFailure> {
  const { code, message } = await apiError(response);
  switch (code) {
    case "draft_conflict":
      return {
        ok: false,
        conflict: true,
        error:
          "This draft was changed elsewhere since you opened it. Reload to get the latest draft, then make your changes again.",
      };
    case "not_publishable":
      return refuse(`This draft cannot be published yet. ${message ?? ""}`.trim());
    case "unchanged":
      return refuse(
        "Nothing to publish: the draft is the same as the latest version. Change it first.",
      );
    case "name_taken":
      return {
        ok: false,
        fields: { name: "A prompt or decision model already has this name. Choose another." },
      };
    case "prompt_published":
      return refuse(
        "A published prompt keeps its name and cannot be deleted: clients use it by name.",
      );
    case "not_found":
      return refuse("This prompt or version no longer exists. Reload the page.");
    case "rate_limited":
      return refuse("Too many requests. Try again in a moment.");
    case "prompt_limit":
    case "invalid_variables":
    case "wrong_kind":
    case "invalid_model":
    case "storage_quota_exceeded":
    case "unknown_tool":
    case "too_many_tools":
    case "tool_not_granted":
      return refuse(message ?? "The request was refused.");
  }
  throw apiFault("studio", response.status, code);
}

/** A name in a path: one segment, its `/` sent as `%2F`. Undefined for a name that is not a prompt name. */
function promptPath(name: string): string | undefined {
  return PromptNameSchema.safeParse(name).success
    ? `/v1/prompts/${encodeURIComponent(name)}`
    : undefined;
}

/** A version number or label, as `:version` in a path; undefined for anything else. */
const versionSegment = (version: string): string | undefined =>
  PromptVersionParamSchema.safeParse(version).success ? encodeURIComponent(version) : undefined;

const GONE = refuse("This prompt no longer exists. Reload the page.");

type Studio = Pick<
  ConsoleService,
  | "prompts"
  | "prompt"
  | "promptVersion"
  | "templateVariables"
  | "createPrompt"
  | "renamePrompt"
  | "deletePrompt"
  | "saveDraft"
  | "publishPrompt"
  | "setPromptLabel"
  | "removePromptLabel"
  | "promptVariables"
  | "startPlaygroundChat"
  | "runDecision"
  | "judgment"
>;

export function createStudio(deps: ConsoleDeps): Studio {
  const { api } = deps;

  /** A read: the body, or undefined for "not found"; anything else that is not success throws. */
  async function read(access: ChatAccess, path: string): Promise<unknown> {
    const response = await api({ method: "GET", path, token: access.token });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`the api refused a studio read: ${response.status}`);
    return response.json();
  }

  async function getPrompt(access: ChatAccess, name: string) {
    const path = promptPath(name);
    const body = path ? await read(access, path) : undefined;
    return body === undefined ? undefined : PromptSchema.parse(body);
  }

  async function getVersion(access: ChatAccess, name: string, version: string) {
    const path = promptPath(name);
    const segment = versionSegment(version);
    if (!path || !segment) return undefined;
    const body = await read(access, `${path}/versions/${segment}`);
    return body === undefined ? undefined : PromptVersionSchema.parse(body);
  }

  return {
    async prompts(access, kind) {
      const query = kind ? `?kind=${kind}` : "";
      const response = await api({
        method: "GET",
        path: `/v1/prompts${query}`,
        token: access.token,
      });
      if (!response.ok) throw new Error(`the api refused a prompt list: ${response.status}`);
      return ListPromptsResponseSchema.parse(await response.json()).prompts;
    },

    prompt: getPrompt,
    promptVersion: getVersion,
    templateVariables,

    async createPrompt(access, form) {
      const parsed = parseForm(CreateForm, form);
      if (!parsed.ok) return parsed;
      const response = await api({
        method: "POST",
        path: "/v1/prompts",
        token: access.token,
        body: CreatePromptRequestSchema.parse(parsed.data),
      });
      if (response.status !== 201) return refusal(response);
      return { ok: true, name: PromptSchema.parse(await response.json()).name };
    },

    async renamePrompt(access, name, form) {
      const path = promptPath(name);
      if (!path) return GONE;
      const parsed = parseForm(RenameForm, form);
      if (!parsed.ok) return parsed;
      const response = await api({
        method: "PATCH",
        path,
        token: access.token,
        body: parsed.data,
      });
      if (!response.ok) return refusal(response);
      return { ok: true, name: PromptSchema.parse(await response.json()).name };
    },

    async deletePrompt(access, name) {
      const path = promptPath(name);
      if (!path) return GONE;
      const response = await api({ method: "DELETE", path, token: access.token });
      if (response.status !== 204) return refusal(response);
      return { ok: true };
    },

    async saveDraft(access, name, revision, draft) {
      const path = promptPath(name);
      if (!path) return GONE;
      const request = SaveDraftRequestSchema.safeParse({ revision, draft });
      if (!request.success) {
        return refuse(
          `The draft is not valid: ${request.error.issues
            .map((issue) => `${issue.path.join(".") || "draft"}: ${issue.message}`)
            .join("; ")}.`,
        );
      }
      const response = await api({
        method: "PUT",
        path: `${path}/draft`,
        token: access.token,
        body: request.data,
      });
      if (!response.ok) return refusal(response);
      return { ok: true, prompt: PromptSchema.parse(await response.json()) };
    },

    async publishPrompt(access, name, revision, form) {
      const path = promptPath(name);
      if (!path) return GONE;
      const parsed = parseForm(PublishForm, form);
      if (!parsed.ok) return parsed;
      const { note } = parsed.data;
      const response = await api({
        method: "POST",
        path: `${path}/versions`,
        token: access.token,
        body: PublishPromptRequestSchema.parse({ revision, ...(note ? { note } : {}) }),
      });
      if (response.status !== 201) return refusal(response);
      return { ok: true, version: PromptVersionSummarySchema.parse(await response.json()) };
    },

    async setPromptLabel(access, name, form) {
      const path = promptPath(name);
      if (!path) return GONE;
      const parsed = parseForm(LabelForm, form);
      if (!parsed.ok) return parsed;
      const { label, version } = parsed.data;
      const response = await api({
        method: "PUT",
        path: `${path}/labels/${label}`,
        token: access.token,
        body: SetPromptLabelRequestSchema.parse({ version }),
      });
      if (!response.ok) return refusal(response);
      return { ok: true };
    },

    async removePromptLabel(access, name, label) {
      const path = promptPath(name);
      if (!path || !PromptLabelSchema.safeParse(label).success || label === LATEST_LABEL) {
        return GONE;
      }
      const response = await api({
        method: "DELETE",
        path: `${path}/labels/${label}`,
        token: access.token,
      });
      if (response.status !== 204) return refusal(response);
      return { ok: true };
    },

    async promptVariables(access, name, source) {
      const body =
        source === DRAFT_SOURCE
          ? (await getPrompt(access, name))?.draft
          : (await getVersion(access, name, source))?.body;
      if (!body) return refuse("This prompt or version no longer exists. Choose another.");
      if (body.kind !== "chat") return refuse("This is a decision model: choose a chat prompt.");
      return { ok: true, variables: body.variables };
    },

    async startPlaygroundChat(access, name, form) {
      const parsed = parseForm(PlaygroundForm, form);
      if (!parsed.ok) return parsed;
      const { source } = parsed.data;
      const externalUserId = `${STUDIO_USER_PREFIX}${access.session.userId}`;
      const variables = variableValues(form);
      let request: z.input<typeof CreateConversationRequestSchema>;
      if (source === DRAFT_SOURCE) {
        // A draft has no version to refer to: it goes written out, its variables filled in here as the api would.
        const draft = (await getPrompt(access, name))?.draft;
        if (!draft) return GONE;
        if (draft.kind !== "chat") return refuse("This is a decision model, not a chat prompt.");
        let system: string;
        try {
          system = renderTemplate(draft.text, draft.variables, variables);
        } catch (error) {
          if (error instanceof InvalidVariablesError) return refuse(error.message);
          throw error;
        }
        const noKey = await missingModelKey(deps, access.session.tenantId, draft.model);
        if (noKey) return refuse(noKey);
        request = {
          externalUserId,
          ...(system.trim() ? { system } : {}),
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.guardrails.length > 0 ? { guardrails: draft.guardrails } : {}),
          ...(draft.tools.length > 0 ? { tools: draft.tools } : {}),
        };
      } else {
        const ref = z
          .object({ name: PromptNameSchema, version: PromptVersionParamSchema })
          .safeParse({ name, version: source });
        if (!ref.success) return refuse("Choose the draft or a version.");
        request = {
          externalUserId,
          prompt: {
            ...ref.data,
            ...(Object.keys(variables).length > 0 ? { variables } : {}),
          },
        };
      }
      const created = await api({
        method: "POST",
        path: "/v1/conversations",
        token: access.token,
        body: CreateConversationRequestSchema.parse(request),
      });
      if (created.status !== 201) return refusal(created);
      return { ok: true, id: z.object({ id: z.uuid() }).parse(await created.json()).id };
    },

    async runDecision(access, name, form) {
      const parsed = parseForm(DecisionForm, form);
      if (!parsed.ok) return parsed;
      const { source, state: text } = parsed.data;
      let state: unknown;
      try {
        state = JSON.parse(text);
      } catch (error) {
        return {
          ok: false,
          fields: {
            state: `The state is not valid JSON: ${error instanceof Error ? error.message : "parse error"}.`,
          },
        };
      }
      let request: unknown;
      if (source === DRAFT_SOURCE) {
        const draft = (await getPrompt(access, name))?.draft;
        if (!draft) return GONE;
        if (draft.kind !== "decision")
          return refuse("This is a chat prompt, not a decision model.");
        if (Object.keys(draft.questions).length === 0) {
          return refuse("The draft has no questions yet. Add one and save the draft.");
        }
        request = {
          state,
          questions: draft.questions,
          ...(draft.model ? { model: draft.model } : {}),
        };
      } else {
        const version = PromptVersionParamSchema.safeParse(source);
        if (!version.success) return refuse("Choose the draft or a version.");
        if (!promptPath(name)) return GONE;
        request = { state, prompt: { name, version: version.data } };
      }
      const body = SubmitJudgmentRequestSchema.safeParse(request);
      if (!body.success) {
        // The only part of the request typed here is the state: anything else came from a saved prompt.
        return {
          ok: false,
          fields: { state: body.error.issues[0]?.message ?? "Not a valid state." },
        };
      }
      const submitted = await api({
        method: "POST",
        path: "/v1/judgments",
        token: access.token,
        body: body.data,
      });
      if (submitted.status !== 202) return refusal(submitted);
      return { ok: true, id: z.object({ id: z.uuid() }).parse(await submitted.json()).id };
    },

    async judgment(access, id) {
      if (!z.uuid().safeParse(id).success) return undefined;
      const body = await read(access, `/v1/judgments/${id}`);
      return body === undefined ? undefined : JudgmentSchema.parse(body);
    },
  };
}
