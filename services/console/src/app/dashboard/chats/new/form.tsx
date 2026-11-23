"use client";
import type { PromptSummary } from "@kerby/contracts";
import { useActionState, useState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Field } from "../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../_components/ui.tsx";
import { versionChoices } from "../../studio/_components/shared.ts";
import { PromptVariableFields } from "../../studio/_components/variable-fields.tsx";
import { type CreateChatState, createChatAction } from "../actions.ts";

const textareaClass =
  "block w-full rounded-lg border bg-page px-3 py-2 text-sm text-fg shadow-sm placeholder:text-muted/60 focus:outline-2 focus:outline-offset-0";

const selectClass = `${textareaClass} border-line focus:outline-brand`;

export function NewChatForm({
  providers,
  prompts,
}: {
  providers: string[];
  prompts: PromptSummary[];
}) {
  const [state, action] = useActionState<CreateChatState, FormData>(createChatAction, undefined);
  const [promptName, setPromptName] = useState(state?.values.promptName ?? "");
  const [promptVersion, setPromptVersion] = useState(state?.values.promptVersion ?? "latest");
  const prompt = prompts.find((p) => p.name === promptName);
  const messageError = state?.fields?.message;
  return (
    <Card>
      <form action={action} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="field-promptName" className="block text-sm font-medium text-fg">
            Start from
          </label>
          <select
            id="field-promptName"
            name="promptName"
            value={promptName}
            onChange={(event) => {
              setPromptName(event.target.value);
              setPromptVersion("latest");
            }}
            className={selectClass}
          >
            <option value="">No prompt: write a system prompt</option>
            {prompts.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          {state?.fields?.promptName ? (
            <p className="text-sm text-danger">{state.fields.promptName}</p>
          ) : prompts.length === 0 ? (
            <p className="text-sm text-muted">
              Publish a chat prompt in the Studio to start from it.
            </p>
          ) : null}
        </div>

        {prompt ? (
          <>
            <div className="space-y-1.5">
              <label htmlFor="field-promptVersion" className="block text-sm font-medium text-fg">
                Version
              </label>
              <select
                id="field-promptVersion"
                name="promptVersion"
                value={promptVersion}
                onChange={(event) => setPromptVersion(event.target.value)}
                className={selectClass}
              >
                {versionChoices(prompt).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
              {state?.fields?.promptVersion ? (
                <p className="text-sm text-danger">{state.fields.promptVersion}</p>
              ) : (
                <p className="text-sm text-muted">
                  The prompt sets the system prompt, model and guardrails. A label is read once:
                  moving it later does not change this chat.
                </p>
              )}
            </div>
            <PromptVariableFields
              key={`${prompt.name}@${promptVersion}`}
              name={prompt.name}
              source={promptVersion}
              {...(state ? { values: state.values } : {})}
            />
          </>
        ) : (
          <>
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
              <label htmlFor="field-system" className="block text-sm font-medium text-fg">
                System prompt
              </label>
              <textarea
                id="field-system"
                name="system"
                defaultValue={state?.values.system}
                rows={3}
                maxLength={100_000}
                placeholder="Optional. Leave blank for the workspace default."
                className={`${textareaClass} border-line focus:outline-brand`}
              />
              {state?.fields?.system ? (
                <p className="text-sm text-danger">{state.fields.system}</p>
              ) : null}
            </div>
          </>
        )}
        <div className="space-y-1.5">
          <label htmlFor="field-message" className="block text-sm font-medium text-fg">
            First message
          </label>
          <textarea
            id="field-message"
            name="message"
            defaultValue={state?.values.message}
            rows={5}
            required
            aria-invalid={messageError ? true : undefined}
            className={`${textareaClass} ${messageError ? "border-danger/60 focus:outline-danger" : "border-line focus:outline-brand"}`}
          />
          {messageError ? <p className="text-sm text-danger">{messageError}</p> : null}
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
