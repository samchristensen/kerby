"use client";
import { useActionState } from "react";
import { SecretReveal, SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { type CreateApiKeyState, createApiKeyAction } from "../actions.ts";

export function NewApiKeyForm() {
  const [state, action] = useActionState<CreateApiKeyState, FormData>(
    createApiKeyAction,
    undefined,
  );

  if (state?.ok) {
    return (
      <Card title="Key created">
        <p className="mb-4 text-sm text-zinc-600">
          <span className="font-medium text-zinc-900">{state.key.label || "Untitled key"}</span> is
          ready to use.
        </p>
        <SecretReveal secret={state.secret} />
        <div className="mt-6">
          <ButtonLink href={`/dashboard/api-keys/${state.key.id}`}>Done</ButtonLink>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form action={action} className="space-y-4">
        <Field
          label="Label"
          name="label"
          maxLength={100}
          autoComplete="off"
          placeholder="Production backend"
          hint="Optional. Helps you tell keys apart."
          error={state?.fields?.label}
        />
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div className="flex gap-3">
          <SubmitButton pending="Creating…">Create key</SubmitButton>
          <ButtonLink href="/dashboard/api-keys" variant="secondary">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Card>
  );
}
