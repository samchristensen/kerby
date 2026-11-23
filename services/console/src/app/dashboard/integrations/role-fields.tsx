import type { IntegrationRole } from "@kerby/contracts";
import { ROLES } from "./roles.ts";

/** The role choice, with what each role means. Server-safe. */
export function RoleFields({
  chosen,
  error,
}: {
  chosen: IntegrationRole | undefined;
  error: string | undefined;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-zinc-800">Role</legend>
      {ROLES.map((option) => (
        <label key={option.role} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="role"
            value={option.role}
            defaultChecked={chosen === option.role}
            className="mt-1"
          />
          <span>
            <span className="font-medium text-zinc-900">{option.label}</span>
            <span className="block text-zinc-500">{option.hint}</span>
          </span>
        </label>
      ))}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </fieldset>
  );
}
