"use client";
import Link from "next/link";
import { useActionState } from "react";
import { SecretReveal, SubmitButton } from "../../_components/client.tsx";
import { Field } from "../../_components/field.tsx";
import { Alert, ButtonLink } from "../../_components/ui.tsx";
import { type SignUpState, signUpAction } from "../actions.ts";

export function SignUpForm({ signedIn }: { signedIn: boolean }) {
  const [state, action] = useActionState<SignUpState, FormData>(signUpAction, undefined);

  if (state?.ok) {
    return (
      <div>
        <div className="mb-4 inline-flex rounded-full bg-live/10 p-2 text-live-text">
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-5">
            <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Your workspace is ready</h1>
        <p className="mt-1 mb-6 text-sm text-muted">
          Here is your first API key. Send it as{" "}
          <code className="font-mono">Authorization: Bearer …</code> to call the API.
        </p>
        <SecretReveal secret={state.apiKey} />
        <div className="mt-6">
          <ButtonLink href="/dashboard">Continue to dashboard</ButtonLink>
        </div>
      </div>
    );
  }

  if (signedIn) {
    return (
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-fg">You are already signed in</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Sign out first to create another workspace.</p>
        <ButtonLink href="/dashboard">Open dashboard</ButtonLink>
      </div>
    );
  }

  const fields = state?.fields ?? {};
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-fg">Create your workspace</h1>
      <p className="mt-1 text-sm text-muted">Start running durable agents in a few minutes.</p>
      <form action={action} className="mt-6 space-y-4">
        <Field
          label="Workspace name"
          name="name"
          hint="Lowercase letters, digits and dashes"
          autoComplete="off"
          required
          defaultValue={state?.values.name}
          error={fields.name}
        />
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state?.values.email}
          error={fields.email}
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          hint="At least 10 characters"
          error={fields.password}
        />
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <SubmitButton pending="Creating workspace…" full>
          Create workspace
        </SubmitButton>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand-text hover:text-brand-text/80">
          Sign in
        </Link>
      </p>
    </div>
  );
}
