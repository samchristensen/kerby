"use client";
// A field per variable of a chat prompt's draft or version, named `var.<name>` for the form that posts them. A
// version's variables are loaded when it is chosen.
import type { PromptVariable } from "@kerby/contracts";
import { useEffect, useState } from "react";
import { Alert } from "../../../_components/ui.tsx";
import { promptVariablesAction } from "../actions.ts";
import { inputClass, labelClass } from "./shared.ts";

type Loaded = { key: string; variables: PromptVariable[] } | { key: string; error: string };

export function PromptVariableFields({
  name,
  source,
  known,
  values,
}: {
  name: string;
  /** `draft`, a version number or a label; empty for none chosen yet. */
  source: string;
  /** Variables already at hand (the draft's), so none are loaded. */
  known?: PromptVariable[];
  /** What was typed before a refused submit, by field name. */
  values?: Record<string, string>;
}) {
  const key = `${name}@${source}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>();

  useEffect(() => {
    if (known || !name || !source) return;
    let cancelled = false;
    void promptVariablesAction(name, source).then((result) => {
      if (cancelled) return;
      setLoaded(
        result.ok
          ? { key, variables: result.variables }
          : { key, error: result.error ?? "Its variables could not be loaded." },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [known, name, source, key]);

  if (!name || !source) return null;
  const current = known ? { key, variables: known } : loaded?.key === key ? loaded : undefined;
  if (!current) return <p className="text-sm text-muted">Loading its variables…</p>;
  if ("error" in current) return <Alert tone="error">{current.error}</Alert>;
  if (current.variables.length === 0) {
    return <p className="text-sm text-muted">This prompt has no variables.</p>;
  }
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-fg">Variables</legend>
      {current.variables.map((variable) => (
        <label key={variable.name} className={labelClass}>
          <code className="font-mono">{variable.name}</code>
          {variable.default === undefined ? (
            <span className="ml-2 text-xs text-brand-text">required</span>
          ) : null}
          {variable.description ? (
            <span className="block text-xs font-normal text-muted">{variable.description}</span>
          ) : null}
          <input
            name={`var.${variable.name}`}
            defaultValue={values?.[`var.${variable.name}`]}
            required={variable.default === undefined}
            placeholder={variable.default === undefined ? "" : `Default: ${variable.default}`}
            className={`${inputClass} mt-1.5 font-normal`}
          />
        </label>
      ))}
    </fieldset>
  );
}
