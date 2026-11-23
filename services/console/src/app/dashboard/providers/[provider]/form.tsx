"use client";
import { useActionState, useEffect, useRef } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { SetModelKeyState } from "../actions.ts";

export function ModelKeyForm({
  action,
  providerName,
}: {
  action: (previous: SetModelKeyState, formData: FormData) => Promise<SetModelKeyState>;
  providerName: string;
}) {
  const [state, formAction] = useActionState<SetModelKeyState, FormData>(action, undefined);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <form ref={form} action={formAction} className="space-y-4">
      <Field
        label={`${providerName} API key`}
        name="apiKey"
        type="password"
        autoComplete="off"
        required
        hint="Sealed on arrival; nobody can read it back, including you."
        error={state?.ok ? undefined : state?.fields?.apiKey}
      />
      {state?.ok ? <Alert tone="success">Key saved</Alert> : null}
      {state && !state.ok && state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save key</SubmitButton>
    </form>
  );
}
