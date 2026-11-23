"use server";
import { revalidatePath } from "next/cache";
import type { FormFailure } from "../../../types/index.ts";
import { consoleService } from "../../_lib/console.ts";
import { requireAdmin } from "../../_lib/session.ts";

export type AllowSignupsState = { ok: true; added: number } | FormFailure | undefined;

export async function allowSignupsAction(
  _previous: AllowSignupsState,
  formData: FormData,
): Promise<AllowSignupsState> {
  const session = await requireAdmin();
  const result = await consoleService().allowSignups(session, Object.fromEntries(formData));
  revalidatePath("/dashboard/admin");
  return result;
}

export async function disallowSignupAction(email: string): Promise<void> {
  const session = await requireAdmin();
  await consoleService().disallowSignup(session, email);
  revalidatePath("/dashboard/admin");
}
