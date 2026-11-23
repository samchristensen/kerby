"use client";
import { useActionState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { type CreateChatState, createChatAction } from "../actions.ts";

const textareaClass =
  "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:outline-2 focus:outline-offset-0";

export function NewChatForm({ providers }: { providers: string[] }) {
  const [state, action] = useActionState<CreateChatState, FormData>(createChatAction, undefined);
  const messageError = state?.fields?.message;
  return (
    <Card>
      <form action={action} className="space-y-4">
        <Field
          label="Model"
          name="model"
          defaultValue={state?.values.model}
          maxLength={200}
          autoComplete="off"
          placeholder="provider/model-id"
          hint={
            providers.length > 0
              ? `Keys on file for: ${providers.join(", ")}. Leave blank for the workspace default.`
              : "You have no model keys yet: add one under Model providers. Leave blank for the workspace default."
          }
          error={state?.fields?.model}
        />
        <div className="space-y-1.5">
          <label htmlFor="field-system" className="block text-sm font-medium text-zinc-800">
            System prompt
          </label>
          <textarea
            id="field-system"
            name="system"
            defaultValue={state?.values.system}
            rows={3}
            maxLength={100_000}
            placeholder="Optional. Leave blank for the workspace default."
            className={`${textareaClass} border-zinc-300 focus:outline-indigo-500`}
          />
          {state?.fields?.system ? (
            <p className="text-sm text-red-600">{state.fields.system}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="field-message" className="block text-sm font-medium text-zinc-800">
            First message
          </label>
          <textarea
            id="field-message"
            name="message"
            defaultValue={state?.values.message}
            rows={5}
            required
            aria-invalid={messageError ? true : undefined}
            className={`${textareaClass} ${messageError ? "border-red-400 focus:outline-red-500" : "border-zinc-300 focus:outline-indigo-500"}`}
          />
          {messageError ? <p className="text-sm text-red-600">{messageError}</p> : null}
        </div>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <div className="flex gap-3">
          <SubmitButton pending="Starting…">Start chat</SubmitButton>
          <ButtonLink href="/dashboard/chats" variant="secondary">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Card>
  );
}
