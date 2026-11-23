"use server";
import { revalidatePath } from "next/cache";
import type { FormFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireSession } from "../../_lib/session.ts";

export type SetModelKeyState = { ok: true } | FormFailure | undefined;

export async function setModelKeyAction(
  provider: string,
  _previous: SetModelKeyState,
  formData: FormData,
): Promise<SetModelKeyState> {
  const session = await requireSession();
  const result = await consoleService().setModelKey(
    session,
    provider,
    Object.fromEntries(formData),
  );
  revalidatePath("/dashboard/providers", "layout");
  return result;
}

export async function removeModelKeyAction(provider: string): Promise<void> {
  const session = await requireSession();
  await consoleService().removeModelKey(session, provider);
  revalidatePath("/dashboard/providers", "layout");
}
