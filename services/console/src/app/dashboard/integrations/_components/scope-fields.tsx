// The scope checkboxes of an integration's forms. Server-safe: no hooks here.
import type { ScopeOption } from "../../../../types/index.ts";

export function ScopeFields({
  options,
  checked,
  error,
}: {
  options: ScopeOption[];
  /** Whether each box starts ticked. */
  checked: (option: ScopeOption) => boolean;
  error: string | undefined;
}) {
  return (
    <fieldset className="space-y-2" aria-describedby={error ? "scopes-error" : undefined}>
      <legend className="text-sm font-medium text-zinc-800">Scopes</legend>
      {options.map((option) => (
        <label key={option.scope} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name={option.field}
            defaultChecked={checked(option)}
            className="mt-1"
          />
          <span>
            <span className="font-mono font-medium text-zinc-900">{option.scope}</span>
            <span className="block text-zinc-500">{option.description}</span>
          </span>
        </label>
      ))}
      {error ? (
        <p id="scopes-error" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
