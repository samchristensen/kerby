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
  "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:outline-2 focus:outline-offset-0";

const selectClass = `${textareaClass} border-zinc-300 focus:outline-indigo-500`;

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
          <label htmlFor="field-promptName" className="block text-sm font-medium text-zinc-800">
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
            <p className="text-sm text-red-600">{state.fields.promptName}</p>
          ) : prompts.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Publish a chat prompt in the Studio to start from it.
            </p>
          ) : null}
        </div>

        {prompt ? (
          <>
            <div className="space-y-1.5">
              <label
                htmlFor="field-promptVersion"
                className="block text-sm font-medium text-zinc-800"
              >
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
                <p className="text-sm text-red-600">{state.fields.promptVersion}</p>
              ) : (
                <p className="text-sm text-zinc-500">
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
          </>
        )}
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
