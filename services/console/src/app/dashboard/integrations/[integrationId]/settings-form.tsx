"use client";
import type { IntegrationRole } from "@kerby/contracts";
import { useActionState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { IntegrationFormState } from "../actions.ts";
import { RoleFields } from "../role-fields.tsx";

export function IntegrationSettingsForm({
  action,
  name,
  role,
}: {
  action: (previous: IntegrationFormState, formData: FormData) => Promise<IntegrationFormState>;
  name: string;
  role: IntegrationRole;
}) {
  const [state, formAction] = useActionState<IntegrationFormState, FormData>(action, undefined);
  const failure = state && !state.ok ? state : undefined;
  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Name"
        name="name"
        required
        maxLength={100}
        autoComplete="off"
        defaultValue={name}
        error={failure?.fields?.name}
      />
      <RoleFields chosen={role} error={failure?.fields?.role} />
      {state?.ok ? (
        <Alert tone="success">Saved. Keys already in use pick up a new role within a minute.</Alert>
      ) : null}
      {failure?.error ? <Alert tone="error">{failure.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save</SubmitButton>
    </form>
  );
}
