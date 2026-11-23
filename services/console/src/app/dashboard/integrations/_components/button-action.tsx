"use client";
// One button that runs a server action and shows what it said: an error, a notice, or a secret to copy once.
import { useActionState } from "react";
import { SecretReveal, SubmitButton } from "../../../_components/client.tsx";
import type { ButtonVariant } from "../../../_components/ui.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { ButtonActionState } from "../actions.ts";

export function ButtonAction({
  action,
  label,
  pending,
  variant = "secondary",
  secretNoun,
}: {
  action: (previous: ButtonActionState) => Promise<ButtonActionState>;
  label: string;
  pending: string;
  variant?: ButtonVariant;
  /** What a returned secret is called in the warning. */
  secretNoun?: string;
}) {
  const [state, formAction] = useActionState<ButtonActionState>(action, undefined);
  return (
    <div className="space-y-3">
      <form action={formAction}>
        <SubmitButton pending={pending} variant={variant}>
          {label}
        </SubmitButton>
      </form>
      {state?.ok && state.secret ? (
        <SecretReveal secret={state.secret} {...(secretNoun ? { noun: secretNoun } : {})} />
      ) : null}
      {state?.ok && state.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      {state && !state.ok ? (
        <Alert tone="error">
          {state.error ?? Object.values(state.fields ?? {})[0] ?? "The request was refused."}
        </Alert>
      ) : null}
    </div>
  );
}
