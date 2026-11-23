"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ApiKeyView, FormFailure, IntegrationView } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess, requireSession } from "../../_lib/session.ts";

export type IntegrationFormState =
  | { ok: true; integration: IntegrationView }
  | FormFailure
  | undefined;
export type CreateApiKeyState =
  | { ok: true; key: ApiKeyView; secret: string }
  | FormFailure
  | undefined;

export async function createIntegrationAction(
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const session = await requireSession();
  const result = await consoleService().createIntegration(session, Object.fromEntries(formData));
  if (!result.ok) return result;
  revalidatePath("/dashboard/integrations", "layout");
  redirect(`/dashboard/integrations/${result.integration.id}`);
}

export async function updateIntegrationAction(
  integrationId: string,
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const session = await requireSession();
  const result = await consoleService().updateIntegration(
    session,
    integrationId,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/integrations", "layout");
  return result;
}

export async function archiveIntegrationAction(integrationId: string): Promise<void> {
  const session = await requireSession();
  await consoleService().archiveIntegration(session, integrationId);
  revalidatePath("/dashboard/integrations", "layout");
  redirect("/dashboard/integrations");
}

export async function createApiKeyAction(
  integrationId: string,
  _previous: CreateApiKeyState,
  formData: FormData,
): Promise<CreateApiKeyState> {
  const session = await requireSession();
  const result = await consoleService().createApiKey(
    session,
    integrationId,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/integrations", "layout");
  return result;
}

export async function revokeApiKeyAction(keyId: string): Promise<void> {
  const session = await requireSession();
  await consoleService().revokeApiKey(session, keyId);
  revalidatePath("/dashboard/integrations", "layout");
}

export type ToolGrantsState = { ok: true } | FormFailure | undefined;

/** Replace the tools a restricted integration may use with the checked ones. */
export async function setIntegrationToolsAction(
  integrationId: string,
  _previous: ToolGrantsState,
  formData: FormData,
): Promise<ToolGrantsState> {
  const access = await requireChatAccess();
  const result = await consoleService().setIntegrationTools(
    access,
    integrationId,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/integrations", "layout");
  revalidatePath("/dashboard/tools", "layout");
  return result;
}
