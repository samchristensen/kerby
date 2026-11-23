// A labelled input with an optional hint and error. Server-safe.
import type { InputHTMLAttributes } from "react";

type FieldProps = {
  label: string;
  name: string;
  hint?: string;
  error?: string | undefined;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "name" | "id">;

export function Field({ label, name, hint, error, ...input }: FieldProps) {
  const id = `field-${name}`;
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={`block w-full rounded-lg border bg-page px-3 py-2 text-sm text-fg shadow-sm placeholder:text-muted/60 focus:outline-2 focus:outline-offset-0 ${
          error ? "border-danger/60 focus:outline-danger" : "border-line focus:outline-brand"
        }`}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
