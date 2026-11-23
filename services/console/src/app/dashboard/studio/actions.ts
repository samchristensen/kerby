"use server";
import type { Judgment, PromptVariable } from "@kerby/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormFailure, StudioFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess, requireSession } from "../../_lib/session.ts";

/** A refused form also returns what was typed: React clears an uncontrolled form once its action completes. */
export type StudioFormState = (FormFailure & { values: Record<string, string> }) | undefined;

const promptPage = (name: string, view?: string) =>
  `/dashboard/studio/prompts/${name}${view ? `?view=${view}` : ""}`;

/** The tree in the layout and the open prompt both change with every write. */
const refreshStudio = () => revalidatePath("/dashboard/studio", "layout");

const typed = (form: Record<string, FormDataEntryValue>, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, String(form[name] ?? "")]));

export async function createPromptAction(
  _previous: StudioFormState,
  formData: FormData,
): Promise<StudioFormState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().createPrompt(access, form);
  if (!result.ok) return { ...result, values: typed(form, ["name", "kind"]) };
  refreshStudio();
  redirect(promptPage(result.name));
}

export async function renamePromptAction(
  name: string,
  _previous: StudioFormState,
  formData: FormData,
): Promise<StudioFormState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().renamePrompt(access, name, form);
  if (!result.ok) return { ...result, values: typed(form, ["name"]) };
  refreshStudio();
  redirect(promptPage(result.name));
}

export async function deletePromptAction(
  name: string,
  _previous: FormFailure | undefined,
): Promise<FormFailure | undefined> {
  const access = await requireChatAccess();
  const result = await consoleService().deletePrompt(access, name);
  if (!result.ok) return result;
  refreshStudio();
  redirect("/dashboard/studio");
}

export type SaveResult = { ok: true } | StudioFailure;

/** Save the draft the editor built, if it is still at `revision`. */
export async function saveDraftAction(
  name: string,
  revision: number,
  draft: unknown,
): Promise<SaveResult> {
  const access = await requireChatAccess();
  const result = await consoleService().saveDraft(access, name, revision, draft);
  if (!result.ok) return result;
  refreshStudio();
  return { ok: true };
}

export type PublishResult = { ok: true; version: number } | StudioFailure;

export async function publishPromptAction(
  name: string,
  revision: number,
  note: string,
): Promise<PublishResult> {
  const access = await requireChatAccess();
  const result = await consoleService().publishPrompt(access, name, revision, { note });
  if (!result.ok) return result;
  refreshStudio();
  return { ok: true, version: result.version.version };
}

export async function setLabelAction(
  name: string,
  _previous: StudioFormState,
  formData: FormData,
): Promise<StudioFormState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().setPromptLabel(access, name, form);
  if (!result.ok) return { ...result, values: typed(form, ["label", "version"]) };
  refreshStudio();
  return undefined;
}

export async function removeLabelAction(
  name: string,
  label: string,
): Promise<FormFailure | undefined> {
  const access = await requireChatAccess();
  const result = await consoleService().removePromptLabel(access, name, label);
  if (!result.ok) return result;
  refreshStudio();
  return undefined;
}

/** The `{{variables}}` the editor's text refers to: the editor keeps its variables table in step with them. */
export async function templateVariablesAction(text: string): Promise<string[]> {
  await requireSession();
  return consoleService().templateVariables(text);
}

/** The variables of a chat prompt's draft or version, for a form that fills them in. */
export async function promptVariablesAction(
  name: string,
  source: string,
): Promise<{ ok: true; variables: PromptVariable[] } | FormFailure> {
  return consoleService().promptVariables(await requireChatAccess(), name, source);
}

/** Start a playground conversation, then open it in Chats. */
export async function playgroundChatAction(
  name: string,
  _previous: StudioFormState,
  formData: FormData,
): Promise<StudioFormState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().startPlaygroundChat(access, name, form);
  if (!result.ok) {
    const values = Object.fromEntries(
      Object.entries(form).map(([field, value]) => [field, String(value)]),
    );
    return { ...result, values };
  }
  redirect(`/dashboard/chats/${result.id}`);
}

export type RunDecisionResult = { ok: true; id: string } | FormFailure;

export async function runDecisionAction(
  name: string,
  source: string,
  state: string,
): Promise<RunDecisionResult> {
  return consoleService().runDecision(await requireChatAccess(), name, { source, state });
}

export async function judgmentAction(id: string): Promise<Judgment | undefined> {
  return consoleService().judgment(await requireChatAccess(), id);
}
