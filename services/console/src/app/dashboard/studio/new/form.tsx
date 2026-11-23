"use client";
import type { PromptKind } from "@kerby/contracts";
import { useActionState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { createPromptAction, type StudioFormState } from "../actions.ts";

const KINDS: { kind: PromptKind; label: string; hint: string }[] = [
  {
    kind: "chat",
    label: "Chat prompt",
    hint: "A system prompt with its model, guardrails and variables.",
  },
  {
    kind: "decision",
    label: "Decision model",
    hint: "The questions a judgment asks of a state, and its model.",
  },
];

export function NewPromptForm({ kind }: { kind: PromptKind }) {
  const [state, action] = useActionState<StudioFormState, FormData>(createPromptAction, undefined);
  const chosen = state?.values.kind ?? kind;
  return (
    <Card>
      <form action={action} className="space-y-4">
        <Field
          label="Name"
          name="name"
          defaultValue={state?.values.name}
          required
          maxLength={200}
          autoComplete="off"
          placeholder="support/triage"
          hint="Lowercase letters, digits and -, in up to 5 segments joined by / (folders in the tree)."
          error={state?.fields?.name}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-zinc-800">Kind</legend>
          {KINDS.map((option) => (
            <label key={option.kind} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                value={option.kind}
                defaultChecked={chosen === option.kind}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-zinc-900">{option.label}</span>
                <span className="block text-zinc-500">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div className="flex gap-3">
          <SubmitButton pending="Creating…">Create</SubmitButton>
          <ButtonLink href="/dashboard/studio" variant="secondary">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Card>
  );
}
