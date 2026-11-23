"use client";
import { useActionState } from "react";
import type { ScopeOption } from "../../../../types/index.ts";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { ScopeFields } from "../_components/scope-fields.tsx";
import { createIntegrationAction, type IntegrationFormState } from "../actions.ts";

/** Least privilege by default: a new integration runs conversations and nothing else until more is ticked. */
const FIRST_SCOPES = ["conversations"];

export function NewIntegrationForm({ scopes }: { scopes: ScopeOption[] }) {
  const [state, action] = useActionState<IntegrationFormState, FormData>(
    createIntegrationAction,
    undefined,
  );
  return (
    <Card>
      <form action={action} className="space-y-5">
        <Field
          label="Name"
          name="name"
          defaultValue={state?.values.name}
          required
          maxLength={64}
          autoComplete="off"
          placeholder="Support bot"
          hint="Letters, digits, spaces, dots, dashes and underscores."
          error={state?.fields?.name}
        />
        <ScopeFields
          options={scopes}
          checked={(option) =>
            state ? option.field in state.values : FIRST_SCOPES.includes(option.scope)
          }
          error={state?.fields?.scopes}
        />
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
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
