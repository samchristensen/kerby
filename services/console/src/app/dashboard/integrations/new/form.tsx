"use client";
import { useActionState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { createIntegrationAction, type IntegrationFormState } from "../actions.ts";
import { RoleFields } from "../role-fields.tsx";

export function NewIntegrationForm() {
  const [state, action] = useActionState<IntegrationFormState, FormData>(
    createIntegrationAction,
    undefined,
  );
  const failure = state && !state.ok ? state : undefined;
  return (
    <Card>
      <form action={action} className="space-y-4">
        <Field
          label="Name"
          name="name"
          required
          maxLength={100}
          autoComplete="off"
          placeholder="Support bot"
          hint="Unique in your workspace. Helps you tell clients apart."
          error={failure?.fields?.name}
        />
        <RoleFields chosen="restricted" error={failure?.fields?.role} />
        {failure?.error ? <Alert tone="error">{failure.error}</Alert> : null}
        <div className="flex gap-3">
          <SubmitButton pending="Creating…">Create integration</SubmitButton>
          <ButtonLink href="/dashboard/integrations" variant="secondary">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Card>
  );
}
