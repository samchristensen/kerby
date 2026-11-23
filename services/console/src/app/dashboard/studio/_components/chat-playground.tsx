"use client";
// The chat playground: a real conversation from the saved draft or a version, opened in Chats (origin "studio").
import type { Prompt } from "@kerby/contracts";
import { useActionState, useState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Alert, Card } from "../../../_components/ui.tsx";
import { playgroundChatAction, type StudioFormState } from "../actions.ts";
import { inputClass, labelClass, versionChoices } from "./shared.ts";
import { PromptVariableFields } from "./variable-fields.tsx";

export function ChatPlayground({ prompt }: { prompt: Prompt }) {
  const [state, action] = useActionState<StudioFormState, FormData>(
    playgroundChatAction.bind(null, prompt.name),
    undefined,
  );
  const [source, setSource] = useState(state?.values.source ?? "draft");
  const draftVariables = prompt.draft.kind === "chat" ? prompt.draft.variables : [];
  return (
    <Card title="Try it in a chat">
      <form action={action} className="space-y-4">
        <label className={labelClass}>
          Run
          <select
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className={`${inputClass} mt-1.5`}
          >
            <option value="draft">The saved draft</option>
            {versionChoices(prompt).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        <PromptVariableFields
          key={source}
          name={prompt.name}
          source={source}
          {...(source === "draft" ? { known: draftVariables } : {})}
          {...(state ? { values: state.values } : {})}
        />
        <p className="text-sm text-zinc-500">
          This starts a real conversation on your model keys, listed in Chats as a Studio chat.
        </p>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <SubmitButton pending="Starting…">Start chat</SubmitButton>
      </form>
    </Card>
  );
}
