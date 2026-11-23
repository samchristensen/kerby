"use server";
import { revalidatePath } from "next/cache";
import type { ApiKeyView, FormFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireSession } from "../../_lib/session.ts";

export type CreateApiKeyState =
  | { ok: true; key: ApiKeyView; secret: string }
  | FormFailure
  | undefined;

export async function createApiKeyAction(
  _previous: CreateApiKeyState,
  formData: FormData,
): Promise<CreateApiKeyState> {
  const session = await requireSession();
  const result = await consoleService().createApiKey(session, Object.fromEntries(formData));
  revalidatePath("/dashboard/api-keys", "layout");
  return result;
}

export async function revokeApiKeyAction(keyId: string): Promise<void> {
  const session = await requireSession();
  await consoleService().revokeApiKey(session, keyId);
  revalidatePath("/dashboard/api-keys", "layout");
}
