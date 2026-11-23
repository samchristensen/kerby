"use server";
import type { UpdateToolRequest } from "@kerby/contracts";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { FormFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";

export type ToolFormState = { ok: true } | FormFailure | undefined;
/** A refused form also returns what was typed (never the credential): React clears the form once its action completes. */
export type NewServerState = (FormFailure & { values: Record<string, string> }) | undefined;

export async function createToolServerAction(
  _previous: NewServerState,
  formData: FormData,
): Promise<NewServerState> {
  const access = await requireChatAccess();
  const form = Object.fromEntries(formData);
  const result = await consoleService().createToolServer(access, form);
  if (!result.ok) {
    const values = Object.fromEntries(
      ["slug", "url", "auth", "header"].map((name) => [
        name,
        typeof form[name] === "string" ? form[name] : "",
      ]),
    );
    return { ...result, values };
  }
  revalidatePath("/dashboard/tools", "layout");
  redirect(`/dashboard/tools/${result.slug}`);
}

export async function updateToolServerAction(
  slug: string,
  _previous: ToolFormState,
  formData: FormData,
): Promise<ToolFormState> {
  const access = await requireChatAccess();
  const result = await consoleService().updateToolServer(
    access,
    slug,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/tools", "layout");
  return result;
}

export async function replaceToolCredentialAction(
  slug: string,
  _previous: ToolFormState,
  formData: FormData,
): Promise<ToolFormState> {
  const access = await requireChatAccess();
  const result = await consoleService().replaceToolCredential(
    access,
    slug,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/tools", "layout");
  return result;
}

export async function syncToolServerAction(slug: string): Promise<ToolFormState> {
  const access = await requireChatAccess();
  const result = await consoleService().syncToolServer(access, slug);
  revalidatePath("/dashboard/tools", "layout");
  return result;
}

export async function deleteToolServerAction(slug: string): Promise<void> {
  const access = await requireChatAccess();
  const result = await consoleService().deleteToolServer(access, slug);
  if (!result.ok) throw new Error(result.error ?? "the server could not be deleted");
  revalidatePath("/dashboard/tools", "layout");
  redirect("/dashboard/tools");
}

export async function updateToolAction(
  slug: string,
  name: string,
  change: UpdateToolRequest,
): Promise<ToolFormState> {
  const access = await requireChatAccess();
  const result = await consoleService().updateTool(access, slug, name, change);
  revalidatePath("/dashboard/tools", "layout");
  return result;
}

/** Whether the server is still listing its tools: the page polls this while it is. */
export async function toolServerSyncingAction(slug: string): Promise<boolean> {
  const access = await requireChatAccess();
  return (await consoleService().toolServer(access, slug))?.status === "syncing";
}
