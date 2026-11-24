"use server";
import { redirect } from "next/navigation";
import type { FormFailure } from "../../types/index.ts";
import { consoleService } from "../_lib/console.ts";
import { clientAddress, startSession } from "../_lib/session.ts";

const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");

export type LogInState = (FormFailure & { email: string }) | undefined;

export async function logInAction(_previous: LogInState, formData: FormData): Promise<LogInState> {
  const result = await consoleService().logIn(Object.fromEntries(formData), await clientAddress());
  if (!result.ok) return { ...result, email: text(formData.get("email")) };
  await startSession(result.token, result.expiresAt);
  redirect("/dashboard");
}
