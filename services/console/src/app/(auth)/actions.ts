"use server";
import { redirect } from "next/navigation";
import type { FormFailure } from "../../types/index.ts";
import { consoleService } from "../_lib/console.ts";
import { clientAddress, startSession } from "../_lib/session.ts";

/** A refused sign-up with the non-secret values, so the form can show them again. */
export type SignUpState =
  | (FormFailure & { values: { name: string; email: string } })
  | { ok: true; apiKey: string }
  | undefined;

const text = (value: FormDataEntryValue | null): string => (typeof value === "string" ? value : "");

export async function signUpAction(
  _previous: SignUpState,
  formData: FormData,
): Promise<SignUpState> {
  const result = await consoleService().signUp(Object.fromEntries(formData), await clientAddress());
  if (!result.ok) {
    return {
      ...result,
      values: { name: text(formData.get("name")), email: text(formData.get("email")) },
    };
  }
  await startSession(result.token, result.expiresAt);
  return { ok: true, apiKey: result.apiKey };
}

export type LogInState = (FormFailure & { email: string }) | undefined;

export async function logInAction(_previous: LogInState, formData: FormData): Promise<LogInState> {
  const result = await consoleService().logIn(Object.fromEntries(formData), await clientAddress());
  if (!result.ok) return { ...result, email: text(formData.get("email")) };
  await startSession(result.token, result.expiresAt);
  redirect("/dashboard");
}
