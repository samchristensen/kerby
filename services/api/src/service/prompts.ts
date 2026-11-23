// Prompts over HTTP (ADR 0017): the tenant's named, versioned chat prompts and decision models, edited as a draft,
// published as numbered versions and pointed at by labels. Changes that clients may depend on (create, rename, delete,
// publish, labels) are audited in the control plane by prompt id, never by name, which is the tenant's words.
import {
  type ChatPromptRef,
  type CreatePromptRequest,
  type DecisionPromptBody,
  type ListPromptsQuery,
  type ListPromptsResponse,
  type PinnedPrompt,
  type Prompt,
  type PromptBody,
  type PromptRef,
  type PromptVersion,
  type PromptVersionSelector,
  type PromptVersionSummary,
  type PublishPromptRequest,
  parseModelId,
  type RenderedPrompt,
  type SaveDraftRequest,
} from "@kerby/contracts";
import { audit } from "@kerby/control-plane";
import type { TenantContext } from "@kerby/db";
import {
  createPrompt,
  deletePrompt,
  getPrompt,
  getPromptVersion,
  listPrompts,
  PromptKindError,
  publishPrompt,
  removePromptLabel,
  renamePrompt,
  renderTemplate,
  saveDraft,
  setPromptLabel,
} from "@kerby/prompts";
import { type ApiDeps, NotFoundError, type Principal } from "../types/index.ts";

/** `limits.storageBytes` of the caller's tenant, or the deployment's default. */
const quotaOf = (deps: ApiDeps, principal: Principal) => ({
  storageBytes: principal.limits.storageBytes ?? deps.settings.defaultStorageBytes,
});

async function audited(
  deps: ApiDeps,
  principal: Principal,
  action: string,
  detail: Record<string, string | number | null>,
): Promise<void> {
  await audit(deps.control, {
    tenantId: principal.tenantId,
    actor: principal.actor,
    action,
    detail,
  });
}

export async function listTenantPrompts(
  ctx: TenantContext,
  query: ListPromptsQuery,
): Promise<ListPromptsResponse> {
  return { prompts: await listPrompts(ctx.db, query) };
}

export async function createTenantPrompt(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  request: CreatePromptRequest,
): Promise<Prompt> {
  const { id, prompt } = await createPrompt(
    ctx.db,
    { name: request.name, kind: request.kind, draft: request.draft, actor: principal.actor },
    quotaOf(deps, principal),
  );
  await audited(deps, principal, "prompt.create", { promptId: id, kind: request.kind });
  return prompt;
}

export async function getTenantPrompt(ctx: TenantContext, name: string): Promise<Prompt> {
  const stored = await getPrompt(ctx.db, name);
  if (!stored) throw new NotFoundError("no prompt by that name");
  return stored.prompt;
}

export async function renameTenantPrompt(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
  newName: string,
): Promise<Prompt> {
  const { id, prompt } = await renamePrompt(ctx.db, name, newName);
  await audited(deps, principal, "prompt.rename", { promptId: id });
  return prompt;
}

export async function deleteTenantPrompt(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
): Promise<void> {
  const { id } = await deletePrompt(ctx.db, name);
  await audited(deps, principal, "prompt.delete", { promptId: id });
}

export async function saveTenantDraft(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
  request: SaveDraftRequest,
): Promise<Prompt> {
  const { prompt } = await saveDraft(
    ctx.db,
    name,
    { revision: request.revision, draft: request.draft, actor: principal.actor },
    quotaOf(deps, principal),
  );
  return prompt;
}

/**
 * What the deployment refuses in a draft: a model whose provider runs no conversations (chat) or no judgments
 * (decision, guardrails). Whether the tenant holds a key is checked when the prompt is used, not here.
 */
function modelProblems(deps: ApiDeps, body: PromptBody): string[] {
  const problems: string[] = [];
  const check = (what: string, model: string, providers: readonly string[], runs: string) => {
    const parsed = parseModelId(model);
    if (!parsed) problems.push(`${what} "${model}" must look like <provider>/<modelId>`);
    else if (!providers.includes(parsed.provider))
      problems.push(
        `${what} "${model}": "${parsed.provider}" does not run ${runs}; use one of ${providers.join(", ")}`,
      );
  };
  if (body.kind === "chat") {
    if (body.model !== undefined)
      check("model", body.model, deps.settings.modelProviders, "conversations");
    for (const guardrail of body.guardrails)
      if (guardrail.model !== undefined)
        check(
          `guardrail ${guardrail.name}'s model`,
          guardrail.model,
          deps.settings.judgmentProviders,
          "judgments",
        );
  } else if (body.model !== undefined) {
    check("model", body.model, deps.settings.judgmentProviders, "judgments");
  }
  return problems;
}

export async function publishTenantPrompt(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
  request: PublishPromptRequest,
): Promise<PromptVersionSummary> {
  const { id, version } = await publishPrompt(
    ctx.db,
    name,
    {
      revision: request.revision,
      note: request.note,
      actor: principal.actor,
      moreProblems: (body) => modelProblems(deps, body),
    },
    quotaOf(deps, principal),
  );
  await audited(deps, principal, "prompt.publish", { promptId: id, version: version.version });
  return version;
}

/** The version a number or label names; `NotFoundError` when the prompt or that version does not exist. */
export async function getTenantPromptVersion(
  ctx: TenantContext,
  name: string,
  selector: PromptVersionSelector,
): Promise<PromptVersion> {
  const version = await getPromptVersion(ctx.db, name, selector);
  if (!version)
    throw new NotFoundError(
      typeof selector === "number"
        ? `no version ${selector} of a prompt by that name`
        : `no version labelled "${selector}" of a prompt by that name`,
    );
  return version;
}

/**
 * A published chat prompt with its variables filled in: the system prompt, model (null for the deployment's default)
 * and guardrails a conversation started from it runs with. A decision prompt is `PromptKindError`.
 */
export async function renderChatPrompt(
  ctx: TenantContext,
  ref: ChatPromptRef,
): Promise<RenderedPrompt> {
  const version = await getTenantPromptVersion(ctx, ref.name, ref.version);
  if (version.body.kind !== "chat")
    throw new PromptKindError(
      "this is a decision model, not a chat prompt: use it with POST /v1/judgments { state, prompt }",
    );
  return {
    name: version.name,
    version: version.version,
    text: renderTemplate(version.body.text, version.body.variables, ref.variables ?? {}),
    model: version.body.model ?? null,
    guardrails: version.body.guardrails,
  };
}

/** A published decision prompt's questions and model; a chat prompt is `PromptKindError`. */
export async function resolveDecisionPrompt(
  ctx: TenantContext,
  ref: PromptRef,
): Promise<{
  prompt: PinnedPrompt;
  questions: DecisionPromptBody["questions"];
  model: string | undefined;
}> {
  const version = await getTenantPromptVersion(ctx, ref.name, ref.version);
  if (version.body.kind !== "decision")
    throw new PromptKindError(
      "this is a chat prompt, not a decision model: start a conversation with it (POST /v1/conversations { prompt })",
    );
  return {
    prompt: { name: version.name, version: version.version },
    questions: version.body.questions,
    model: version.body.model,
  };
}

export async function setTenantPromptLabel(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
  label: string,
  version: number,
): Promise<Prompt> {
  const { id, prompt } = await setPromptLabel(ctx.db, name, {
    label,
    version,
    actor: principal.actor,
  });
  await audited(deps, principal, "prompt.label", { promptId: id, label, version });
  return prompt;
}

export async function removeTenantPromptLabel(
  deps: ApiDeps,
  principal: Principal,
  ctx: TenantContext,
  name: string,
  label: string,
): Promise<void> {
  const { id } = await removePromptLabel(ctx.db, name, label);
  await audited(deps, principal, "prompt.label", { promptId: id, label, version: null });
}
