"use client";
import type { AvailableTool } from "@kerby/contracts";
import { useActionState } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { ToolPicker } from "../../../_components/tool-picker.tsx";
import { Alert } from "../../../_components/ui.tsx";
import type { ToolGrantsState } from "../actions.ts";

export function ToolGrantsForm({
  action,
  available,
  servers,
  granted,
}: {
  action: (previous: ToolGrantsState, formData: FormData) => Promise<ToolGrantsState>;
  available: AvailableTool[];
  servers: string[];
  granted: string[];
}) {
  const [state, formAction] = useActionState<ToolGrantsState, FormData>(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <ToolPicker available={available} servers={servers} selected={granted} />
      {state?.ok ? (
        <Alert tone="success">Saved. Its keys may name these tools on conversations.</Alert>
      ) : null}
      {state && !state.ok && state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save tools</SubmitButton>
    </form>
  );
}
