"use server";
import type { Subscription } from "@kerby/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ApiKeyView, FormFailure } from "../../../types/index.ts";
import { formatDateTime } from "../../_components/format.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess, requireSession } from "../../_lib/session.ts";

/** A refused form also returns what was typed: React clears an uncontrolled form once its action completes. */
export type IntegrationFormState = (FormFailure & { values: Record<string, string> }) | undefined;

export type ScopesState = { ok: true } | IntegrationFormState;

export type CreateKeyState =
  | { ok: true; key: ApiKeyView; secret: string }
  | FormFailure
  | undefined;

export type CreateSubscriptionState =
  | { ok: true; subscription: Subscription; secret: string }
  | IntegrationFormState;

/** What a one-button action (rotate, test, enable) reports: a line to show, and a secret to show once. */
export type ButtonActionState =
  | { ok: true; notice?: string; secret?: string }
  | FormFailure
  | undefined;

const integrationPage = (id: string) => `/dashboard/integrations/${id}`;

/** The list in the layout counts keys and subscriptions, so every write refreshes the whole section. */
const refresh = () => revalidatePath("/dashboard/integrations", "layout");

/** Every text field of the form, ticked checkboxes included (their value is "on"). */
const typed = (formData: FormData): Record<string, string> =>
  Object.fromEntries(
    [...formData.entries()].flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value]] : [],
    ),
  );

export async function createIntegrationAction(
  _previous: IntegrationFormState,
  formData: FormData,
): Promise<IntegrationFormState> {
  const session = await requireSession();
  const result = await consoleService().createIntegration(session, Object.fromEntries(formData));
  if (!result.ok) return { ...result, values: typed(formData) };
  refresh();
  redirect(integrationPage(result.id));
}

export async function setScopesAction(
  integrationId: string,
  _previous: ScopesState,
  formData: FormData,
): Promise<ScopesState> {
  const session = await requireSession();
  const result = await consoleService().setIntegrationScopes(
    session,
    integrationId,
    Object.fromEntries(formData),
  );
  if (!result.ok) return { ...result, values: typed(formData) };
  refresh();
  return result;
}

export async function deleteIntegrationAction(integrationId: string): Promise<void> {
  const session = await requireSession();
  await consoleService().deleteIntegration(session, integrationId);
  refresh();
  redirect("/dashboard/integrations");
}

export async function createKeyAction(
  integrationId: string,
  _previous: CreateKeyState,
  formData: FormData,
): Promise<CreateKeyState> {
  const session = await requireSession();
  const result = await consoleService().createApiKey(
    session,
    integrationId,
    Object.fromEntries(formData),
  );
  refresh();
  return result;
}

export async function revokeKeyAction(keyId: string): Promise<void> {
  const session = await requireSession();
  await consoleService().revokeApiKey(session, keyId);
  refresh();
}

export async function createSubscriptionAction(
  integrationId: string,
  _previous: CreateSubscriptionState,
  formData: FormData,
): Promise<CreateSubscriptionState> {
  const access = await requireChatAccess();
  const result = await consoleService().createSubscription(
    access,
    integrationId,
    Object.fromEntries(formData),
  );
  if (!result.ok) return { ...result, values: typed(formData) };
  refresh();
  return result;
}

export async function setSubscriptionEnabledAction(
  subscriptionId: string,
  enabled: boolean,
  _previous: ButtonActionState,
): Promise<ButtonActionState> {
  const access = await requireChatAccess();
  const result = await consoleService().setSubscriptionEnabled(access, subscriptionId, enabled);
  if (!result.ok) return result;
  refresh();
  return { ok: true };
}

export async function rotateSecretAction(
  subscriptionId: string,
  _previous: ButtonActionState,
): Promise<ButtonActionState> {
  const access = await requireChatAccess();
  const result = await consoleService().rotateSubscriptionSecret(access, subscriptionId);
  if (!result.ok) return result;
  return {
    ok: true,
    secret: result.secret,
    notice: `The previous secret also signs until ${formatDateTime(result.previousExpiresAt)}: switch your endpoint to the new one before then.`,
  };
}

export async function testSubscriptionAction(
  subscriptionId: string,
  _previous: ButtonActionState,
): Promise<ButtonActionState> {
  const access = await requireChatAccess();
  const result = await consoleService().testSubscription(access, subscriptionId);
  if (!result.ok) return result;
  refresh();
  return {
    ok: true,
    notice: `A ping (${result.eventId}) is on its way. Reload to see it in the delivery log.`,
  };
}

export async function deleteSubscriptionAction(
  integrationId: string,
  subscriptionId: string,
): Promise<void> {
  const access = await requireChatAccess();
  // Refused only when it is already gone: either way it is not there any more.
  await consoleService().deleteSubscription(access, subscriptionId);
  refresh();
  redirect(integrationPage(integrationId));
}
