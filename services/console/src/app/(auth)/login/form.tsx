"use client";
import { useActionState } from "react";
import { SubmitButton } from "../../_components/client.tsx";
import { Field } from "../../_components/field.tsx";
import { Alert } from "../../_components/ui.tsx";
import { type LogInState, logInAction } from "../actions.ts";

export function LogInForm() {
  const [state, action] = useActionState<LogInState, FormData>(logInAction, undefined);
  const fields = state?.fields ?? {};
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-fg">Sign in to Kerby</h1>
      <p className="mt-1 text-sm text-muted">
        Use the admin account configured for this install: its email is{" "}
        <code className="font-mono">KERBY_ADMIN_EMAIL</code>.
      </p>
      <form action={action} className="mt-6 space-y-4">
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state?.email}
          error={fields.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={fields.password}
        />
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <SubmitButton pending="Signing in…" full>
          Sign in
        </SubmitButton>
      </form>
    </div>
  );
}
