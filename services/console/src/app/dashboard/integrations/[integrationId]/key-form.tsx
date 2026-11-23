"use client";
import { useActionState } from "react";
import { SecretReveal, SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { CreateApiKeyState } from "../actions.ts";

export function NewKeyForm({
  action,
}: {
  action: (previous: CreateApiKeyState, formData: FormData) => Promise<CreateApiKeyState>;
}) {
  const [state, formAction] = useActionState<CreateApiKeyState, FormData>(action, undefined);
  const failure = state && !state.ok ? state : undefined;
  return (
    <div className="space-y-4">
      {state?.ok ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">{state.key.label || "Untitled key"}</span> is
            ready to use.
          </p>
          <SecretReveal secret={state.secret} />
        </div>
      ) : null}
      <form action={formAction} className="space-y-4">
        <Field
          label="Label"
          name="label"
          maxLength={100}
          autoComplete="off"
          placeholder="Production backend"
          hint="Optional. Helps you tell keys apart."
          error={failure?.fields?.label}
        />
        {failure?.error ? <Alert tone="error">{failure.error}</Alert> : null}
        <SubmitButton pending="Creating…">Create key</SubmitButton>
      </form>
    </div>
  );
}
