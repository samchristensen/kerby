"use client";
import { useActionState, useState } from "react";
import type { EventTypeOptions } from "../../../../../../types/index.ts";
import { SecretReveal, SubmitButton } from "../../../../../_components/client.tsx";
import { Field } from "../../../../../_components/field.tsx";
import { Alert, ButtonLink, Card } from "../../../../../_components/ui.tsx";
import type { CreateSubscriptionState } from "../../../actions.ts";

function Checkbox({
  field,
  label,
  checked,
  covered,
  onChange,
  strong = false,
}: {
  field: string;
  label: string;
  checked: boolean;
  /** Ticked by a wildcard above it: shown ticked, not sent. */
  covered: boolean;
  onChange: (field: string, checked: boolean) => void;
  strong?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 text-sm ${covered ? "text-muted" : ""}`}>
      <input
        type="checkbox"
        name={covered ? undefined : field}
        checked={checked || covered}
        disabled={covered}
        onChange={(event) => onChange(field, event.target.checked)}
      />
      <code className={`font-mono ${strong ? "font-medium" : ""}`}>{label}</code>
    </label>
  );
}

export function NewSubscriptionForm({
  action,
  types,
  tenantScope,
  cancelHref,
  subscriptionHref,
}: {
  action: (
    previous: CreateSubscriptionState,
    formData: FormData,
  ) => Promise<CreateSubscriptionState>;
  types: EventTypeOptions;
  /** Whether the integration holds the `tenant` scope, which a workspace-wide subscription needs. */
  tenantScope: boolean;
  cancelHref: string;
  /** The page of a subscription by id. */
  subscriptionHref: string;
}) {
  const [state, formAction] = useActionState<CreateSubscriptionState, FormData>(action, undefined);
  const refused = state && !state.ok ? state : undefined;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  // A refused form comes back cleared by React: tick again what was ticked.
  const [restored, setRestored] = useState<CreateSubscriptionState>(undefined);
  if (refused && restored !== state) {
    setRestored(state);
    const fields = [types.all, ...types.families.flatMap((f) => [f.wildcard, ...f.types])];
    setChecked(
      new Set(fields.map(({ field }) => field).filter((field) => field in refused.values)),
    );
  }

  if (state?.ok) {
    return (
      <Card title="Subscription created">
        <p className="mb-4 text-sm text-muted">
          Events go to{" "}
          <code className="font-mono text-fg">{state.subscription.destination.url}</code> from now
          on. Each request is signed with this secret (Standard Webhooks): verify the{" "}
          <code className="font-mono">webhook-signature</code> header with it.
        </p>
        <SecretReveal secret={state.secret} noun="signing secret" />
        <div className="mt-6">
          <ButtonLink href={`${subscriptionHref}/${state.subscription.id}`}>Done</ButtonLink>
        </div>
      </Card>
    );
  }

  const toggle = (field: string, on: boolean) =>
    setChecked((previous) => {
      const next = new Set(previous);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  const all = checked.has(types.all.field);

  return (
    <Card>
      <form action={formAction} className="space-y-5">
        <Field
          label="Endpoint URL"
          name="url"
          type="url"
          required
          maxLength={2048}
          autoComplete="off"
          defaultValue={refused?.values.url}
          placeholder="https://example.com/webhooks/kerby"
          hint="Receives a signed POST per event. Answer 2xx to acknowledge; 410 turns the subscription off."
          error={refused?.fields?.url}
        />
        <Field
          label="Description"
          name="description"
          maxLength={200}
          autoComplete="off"
          defaultValue={refused?.values.description}
          placeholder="Ticket updates"
          hint="Optional."
          error={refused?.fields?.description}
        />
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-fg">Event types</legend>
          <Checkbox
            field={types.all.field}
            label="* (every type, including ones added later)"
            checked={all}
            covered={false}
            onChange={toggle}
            strong
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {types.families.map((family) => {
              const wildcard = all || checked.has(family.wildcard.field);
              return (
                <div key={family.family} className="space-y-1.5 rounded-lg border border-line p-3">
                  <Checkbox
                    field={family.wildcard.field}
                    label={family.wildcard.pattern}
                    checked={checked.has(family.wildcard.field)}
                    covered={all}
                    onChange={toggle}
                    strong
                  />
                  <div className="space-y-1.5 pl-5">
                    {family.types.map((type) => (
                      <Checkbox
                        key={type.field}
                        field={type.field}
                        label={type.pattern}
                        checked={checked.has(type.field)}
                        covered={wildcard}
                        onChange={toggle}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {refused?.fields?.types ? (
            <p className="text-sm text-danger">{refused.fields.types}</p>
          ) : null}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Whose events</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value="own"
              defaultChecked={refused?.values.scope !== "tenant"}
              className="mt-1"
            />
            <span>
              <span className="font-medium text-fg">This integration's</span>
              <span className="block text-muted">
                What its keys started: their conversations and judgments.
              </span>
            </span>
          </label>
          <label className={`flex items-start gap-2 text-sm ${tenantScope ? "" : "opacity-60"}`}>
            <input
              type="radio"
              name="scope"
              value="tenant"
              disabled={!tenantScope}
              defaultChecked={tenantScope && refused?.values.scope === "tenant"}
              className="mt-1"
            />
            <span>
              <span className="font-medium text-fg">The whole workspace's</span>
              <span className="block text-muted">
                {tenantScope
                  ? "Everything: other integrations' work and chats started in this console too."
                  : "Needs the tenant scope: add it to this integration first."}
              </span>
            </span>
          </label>
          {refused?.fields?.scope ? (
            <p className="text-sm text-danger">{refused.fields.scope}</p>
          ) : null}
        </fieldset>
        {refused?.error ? <Alert tone="error">{refused.error}</Alert> : null}
        <div className="flex gap-3">
          <SubmitButton pending="Creating…">Create subscription</SubmitButton>
          <ButtonLink href={cancelHref} variant="secondary">
            Cancel
          </ButtonLink>
        </div>
      </form>
    </Card>
  );
}
