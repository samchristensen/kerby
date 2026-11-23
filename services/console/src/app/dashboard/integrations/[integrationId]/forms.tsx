"use client";
import { useActionState, useEffect, useRef } from "react";
import type { ScopeOption } from "../../../../types/index.ts";
import { SecretReveal, SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert } from "../../../_components/ui.tsx";
import { ScopeFields } from "../_components/scope-fields.tsx";
import type { CreateKeyState, ScopesState } from "../actions.ts";

export function ScopesForm({
  action,
  options,
  scopes,
}: {
  action: (previous: ScopesState, formData: FormData) => Promise<ScopesState>;
  options: ScopeOption[];
  /** The integration's scopes now. */
  scopes: string[];
}) {
  const [state, formAction] = useActionState<ScopesState, FormData>(action, undefined);
  const refused = state && !state.ok ? state : undefined;
  return (
    <form action={formAction} className="space-y-4">
      <ScopeFields
        options={options}
        checked={(option) =>
          refused ? option.field in refused.values : scopes.includes(option.scope)
        }
        error={refused?.fields?.scopes}
      />
      {state?.ok ? (
        <Alert tone="success">
          Scopes saved. Its keys follow within the API's authentication cache time.
        </Alert>
      ) : null}
      {refused?.error ? <Alert tone="error">{refused.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save scopes</SubmitButton>
    </form>
  );
}

export function NewKeyForm({
  action,
}: {
  action: (previous: CreateKeyState, formData: FormData) => Promise<CreateKeyState>;
}) {
  const [state, formAction] = useActionState<CreateKeyState, FormData>(action, undefined);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <div className="space-y-4">
      {state?.ok ? (
        <div className="space-y-2">
          <p className="text-sm text-zinc-600">
            <span className="font-medium text-zinc-900">{state.key.label || "Untitled key"}</span>{" "}
            is ready to use.
          </p>
          <SecretReveal secret={state.secret} />
        </div>
      ) : null}
      <form ref={form} action={formAction} className="space-y-3">
        <Field
          label="New key label"
          name="label"
          maxLength={100}
          autoComplete="off"
          placeholder="Production"
          hint="Optional. Helps you tell keys apart."
          error={state && !state.ok ? state.fields?.label : undefined}
        />
        <SubmitButton pending="Creating…">Create key</SubmitButton>
      </form>
      {state && !state.ok && state.error ? <Alert tone="error">{state.error}</Alert> : null}
    </div>
  );
}
