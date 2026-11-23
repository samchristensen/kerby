import type { z } from "zod";
import type { FormFailure, FormInput } from "../types/index.ts";

/**
 * Parse a submitted form at the boundary. A refusal names each bad field with its schema's message, capitalized for
 * the form; it never echoes a value.
 */
export function parseForm<S extends z.ZodType>(
  schema: S,
  form: FormInput,
): { ok: true; data: z.output<S> } | FormFailure {
  const result = schema.safeParse(form);
  if (result.success) return { ok: true, data: result.data };
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    fields[field] ??= issue.message.charAt(0).toUpperCase() + issue.message.slice(1);
  }
  return { ok: false, fields };
}

/** A refusal for the whole form. */
export const refuse = (error: string): FormFailure => ({ ok: false, error });

/** "in 3 minutes" for a wait in seconds. */
export function retryIn(seconds: number): string {
  if (seconds < 90) return `in ${seconds} seconds`;
  return `in ${Math.ceil(seconds / 60)} minutes`;
}
