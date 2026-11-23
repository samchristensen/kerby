"use client";
// A prompt's labels: `latest` (always the newest version, not editable), then each label the tenant set, which can be
// pointed at another version or removed.
import { useActionState, useState, useTransition } from "react";
import { SubmitButton } from "../../../_components/client.tsx";
import { Alert, Badge } from "../../../_components/ui.tsx";
import { removeLabelAction, type StudioFormState, setLabelAction } from "../actions.ts";
import { inputClass, labelClass } from "./shared.ts";

export function LabelsEditor({
  name,
  labels,
  latestVersion,
}: {
  name: string;
  labels: Record<string, number>;
  latestVersion: number;
}) {
  const [state, action] = useActionState<StudioFormState, FormData>(
    setLabelAction.bind(null, name),
    undefined,
  );
  const [removeError, setRemoveError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const versions = Array.from({ length: latestVersion }, (_, index) => latestVersion - index);
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line text-sm">
        <li className="flex items-center justify-between gap-3 py-2 first:pt-0">
          <span className="flex items-center gap-2">
            <Badge tone="live">latest</Badge>
            <span className="text-muted">always the newest version</span>
          </span>
          <span className="font-medium text-fg">v{latestVersion}</span>
        </li>
        {Object.entries(labels).map(([label, version]) => (
          <li key={label} className="flex items-center justify-between gap-3 py-2">
            <Badge tone="brand">{label}</Badge>
            <span className="flex items-center gap-3">
              <span className="font-medium text-fg">v{version}</span>
              <button
                type="button"
                disabled={pending}
                className="text-sm text-danger hover:underline disabled:opacity-60"
                onClick={() =>
                  startTransition(async () => {
                    setRemoveError((await removeLabelAction(name, label))?.error);
                  })
                }
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {removeError ? <Alert tone="error">{removeError}</Alert> : null}
      <form action={action} className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_auto]">
        <label className={labelClass}>
          Label
          <input
            name="label"
            required
            maxLength={32}
            defaultValue={state?.values.label}
            placeholder="production"
            autoComplete="off"
            className={`${inputClass} mt-1.5`}
          />
        </label>
        <label className={labelClass}>
          Version
          <select
            name="version"
            defaultValue={state?.values.version ?? String(latestVersion)}
            className={`${inputClass} mt-1.5`}
          >
            {versions.map((version) => (
              <option key={version} value={version}>
                v{version}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton variant="secondary" pending="Saving…">
          Set label
        </SubmitButton>
      </form>
      <p className="text-xs text-muted">
        Setting a label that exists moves it. A conversation or judgment keeps the version it
        started with.
      </p>
      {state?.fields?.label ? <Alert tone="error">{state.fields.label}</Alert> : null}
      {state?.fields?.version ? <Alert tone="error">{state.fields.version}</Alert> : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
    </div>
  );
}
