"use client";
import { useActionState, useState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { EmbeddingModelState } from "../actions.ts";

export function EmbeddingModelForm({
  action,
  current,
  suggestions,
}: {
  action: (previous: EmbeddingModelState, formData: FormData) => Promise<EmbeddingModelState>;
  current: string | null;
  suggestions: string[];
}) {
  const [state, formAction] = useActionState<EmbeddingModelState, FormData>(action, undefined);
  // Controlled: React resets an uncontrolled form once its action completes, which would drop a refused value.
  const [model, setModel] = useState(current ?? "");
  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Embedding model"
        name="embeddingModel"
        list="embedding-model-suggestions"
        value={model}
        onChange={(event) => setModel(event.target.value)}
        placeholder="openai/text-embedding-3-small"
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        hint="A model id, <provider>/<model-id>. Leave it blank to search by words only."
        error={state?.ok ? undefined : state?.fields?.embeddingModel}
      />
      <datalist id="embedding-model-suggestions">
        {suggestions.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
      {state?.ok ? (
        <Alert tone="success">
          {state.embeddingModel
            ? `Saved. Your chats are being embedded with ${state.embeddingModel}.`
            : "Saved. Search uses words only."}
        </Alert>
      ) : null}
      {state && !state.ok && state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save</SubmitButton>
    </form>
  );
}
