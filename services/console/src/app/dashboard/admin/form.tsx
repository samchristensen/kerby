"use client";
import { useActionState, useEffect, useRef } from "react";
import { SubmitButton } from "../../_components/client.tsx";
import { Alert } from "../../_components/ui.tsx";
import { type AllowSignupsState, allowSignupsAction } from "./actions.ts";

export function AllowSignupsForm() {
  const [state, action] = useActionState<AllowSignupsState, FormData>(
    allowSignupsAction,
    undefined,
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  const error = state?.ok ? undefined : state?.fields?.emails;
  return (
    <form ref={form} action={action} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="field-emails" className="block text-sm font-medium text-zinc-800">
          Email addresses
        </label>
        <textarea
          id="field-emails"
          name="emails"
          rows={3}
          required
          aria-invalid={error ? true : undefined}
          placeholder="ada@example.com, grace@example.com"
          className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:outline-2 focus:outline-offset-0 ${
            error
              ? "border-red-400 focus:outline-red-500"
              : "border-zinc-300 focus:outline-indigo-500"
          }`}
        />
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : (
          <p className="text-sm text-zinc-500">
            One or several, separated by spaces, commas or new lines.
          </p>
        )}
      </div>
      {state?.ok ? (
        <Alert tone="success">
          {state.added === 0 ? "All of them were already allowed" : `${state.added} added`}
        </Alert>
      ) : null}
      {state && !state.ok && state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pending="Adding…">Allow sign-up</SubmitButton>
    </form>
  );
}
