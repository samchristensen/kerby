"use client";
// Rename or delete a prompt: only before its first publish, since clients use a published prompt by its name.
import { useActionState, useState } from "react";
import type { FormFailure } from "../../../../types/index.ts";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, buttonStyles, Card } from "../../../_components/ui.tsx";
import { deletePromptAction, renamePromptAction, type StudioFormState } from "../actions.ts";

export function ManagePrompt({ name }: { name: string }) {
  const [renamed, rename] = useActionState<StudioFormState, FormData>(
    renamePromptAction.bind(null, name),
    undefined,
  );
  const [deleted, remove] = useActionState<FormFailure | undefined, FormData>(
    deletePromptAction.bind(null, name),
    undefined,
  );
  const [asking, setAsking] = useState(false);
  return (
    <Card title="Name">
      <p className="mb-4 text-sm text-muted">
        Until it is published, this prompt can be renamed or deleted. After that its name is fixed.
      </p>
      <form action={rename} className="space-y-3">
        <Field
          label="New name"
          name="name"
          defaultValue={renamed?.values.name ?? name}
          required
          maxLength={200}
          autoComplete="off"
          error={renamed?.fields?.name}
        />
        {renamed?.error ? <Alert tone="error">{renamed.error}</Alert> : null}
        <SubmitButton variant="secondary" pending="Renaming…">
          Rename
        </SubmitButton>
      </form>
      <div className="mt-5 border-t border-line pt-4">
        {asking ? (
          <form
            action={remove}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3"
          >
            <p className="flex-1 text-sm text-danger">Delete this prompt and its draft?</p>
            <button
              type="button"
              className={buttonStyles.secondary}
              onClick={() => setAsking(false)}
            >
              Cancel
            </button>
            <SubmitButton variant="danger" pending="Deleting…">
              Delete
            </SubmitButton>
          </form>
        ) : (
          <button type="button" className={buttonStyles.secondary} onClick={() => setAsking(true)}>
            <span className="text-danger">Delete prompt</span>
          </button>
        )}
        {deleted?.error ? (
          <div className="mt-3">
            <Alert tone="error">{deleted.error}</Alert>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
