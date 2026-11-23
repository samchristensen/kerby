"use client";
// The forms of the Tools pages: adding a server, changing its address and auth, replacing its credential, listing its
// tools again, each tool's switches, and the refresh while a worker lists the tools.
import type { Tool, ToolServerAuth } from "@kerby/contracts";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
import { SubmitButton } from "../../_components/client.tsx";
import { Field } from "../../_components/field.tsx";
import { Alert, buttonStyles, Card } from "../../_components/ui.tsx";
import {
  createToolServerAction,
  type NewServerState,
  type ToolFormState,
  toolServerSyncingAction,
  updateToolAction,
} from "./actions.ts";

/** No auth, or a credential sent in one header. The credential is never shown: blank keeps the stored one on a change. */
function AuthFields({
  auth,
  hasCredential,
  fields,
}: {
  auth: ToolServerAuth | undefined;
  hasCredential: boolean;
  fields: Record<string, string> | undefined;
}) {
  const [kind, setKind] = useState<ToolServerAuth["kind"]>(auth?.kind ?? "none");
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-zinc-800">Authentication</legend>
      <div className="flex gap-6 text-sm">
        {(["none", "header"] as const).map((option) => (
          <label key={option} className="flex items-center gap-2">
            <input
              type="radio"
              name="auth"
              value={option}
              checked={kind === option}
              onChange={() => setKind(option)}
            />
            {option === "none" ? "None" : "A credential in a header"}
          </label>
        ))}
      </div>
      {fields?.auth ? <p className="text-sm text-red-600">{fields.auth}</p> : null}
      {kind === "header" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Header"
            name="header"
            required
            maxLength={64}
            autoComplete="off"
            defaultValue={auth?.kind === "header" ? auth.header : "Authorization"}
            error={fields?.header}
          />
          <Field
            label="Credential"
            name="credential"
            type="password"
            maxLength={4096}
            autoComplete="off"
            required={!hasCredential}
            placeholder={hasCredential ? "Leave blank to keep the stored one" : "Bearer …"}
            hint="Sealed when saved: only a worker can open it, and it is never shown again."
            error={fields?.credential}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

export function NewServerForm() {
  const [state, action] = useActionState<NewServerState, FormData>(
    createToolServerAction,
    undefined,
  );
  const auth: ToolServerAuth | undefined =
    state?.values.auth === "header"
      ? { kind: "header", header: state.values.header ?? "" }
      : undefined;
  return (
    <Card>
      <form action={action} className="space-y-4">
        <Field
          label="Name"
          name="slug"
          required
          maxLength={24}
          autoComplete="off"
          placeholder="github"
          defaultValue={state?.values.slug}
          hint="1 to 24 of a-z, 0-9 and -. Fixed once made: tools are named <name>/<tool>."
          error={state?.fields?.slug}
        />
        <Field
          label="URL"
          name="url"
          type="url"
          required
          maxLength={2000}
          autoComplete="off"
          placeholder="https://mcp.example.com/mcp"
          defaultValue={state?.values.url}
          hint="Its MCP endpoint (Streamable HTTP). A server with a credential must use https."
          error={state?.fields?.url}
        />
        <AuthFields
          key={state?.values.auth ?? "none"}
          auth={auth}
          hasCredential={false}
          fields={state?.fields}
        />
        <p className="text-sm text-zinc-500">
          Next, a worker lists the server&apos;s tools. Each arrives disabled: enable the ones your
          conversations may call.
        </p>
        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        <SubmitButton pending="Adding…">Add server</SubmitButton>
      </form>
    </Card>
  );
}

export function EditServerForm({
  action,
  url,
  auth,
  hasCredential,
}: {
  action: (previous: ToolFormState, formData: FormData) => Promise<ToolFormState>;
  url: string;
  auth: ToolServerAuth;
  hasCredential: boolean;
}) {
  const [state, formAction] = useActionState<ToolFormState, FormData>(action, undefined);
  const failure = state && !state.ok ? state : undefined;
  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="URL"
        name="url"
        type="url"
        required
        maxLength={2000}
        autoComplete="off"
        defaultValue={url}
        error={failure?.fields?.url}
      />
      <AuthFields auth={auth} hasCredential={hasCredential} fields={failure?.fields} />
      {state?.ok ? <Alert tone="success">Saved. Its tools are being listed again.</Alert> : null}
      {failure?.error ? <Alert tone="error">{failure.error}</Alert> : null}
      <SubmitButton pending="Saving…">Save</SubmitButton>
    </form>
  );
}

export function CredentialForm({
  action,
}: {
  action: (previous: ToolFormState, formData: FormData) => Promise<ToolFormState>;
}) {
  const [state, formAction] = useActionState<ToolFormState, FormData>(action, undefined);
  const failure = state && !state.ok ? state : undefined;
  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="New credential"
        name="value"
        type="password"
        required
        maxLength={4096}
        autoComplete="off"
        hint="Replaces the stored value, which is never shown."
        error={failure?.fields?.value}
      />
      {state?.ok ? <Alert tone="success">Replaced. Its tools are being listed again.</Alert> : null}
      {failure?.error ? <Alert tone="error">{failure.error}</Alert> : null}
      <SubmitButton pending="Replacing…">Replace credential</SubmitButton>
    </form>
  );
}

export function SyncButton({ action }: { action: () => Promise<ToolFormState> }) {
  const [state, formAction] = useActionState<ToolFormState, FormData>(action, undefined);
  return (
    <form action={formAction} className="flex items-center gap-3">
      <SubmitButton variant="secondary" pending="Asking…">
        List tools again
      </SubmitButton>
      {state && !state.ok ? <span className="text-sm text-red-600">{state.error}</span> : null}
    </form>
  );
}

/** While a worker lists the server's tools, check every few seconds and reload the page once it is done. */
export function RefreshWhileSyncing({ slug }: { slug: string }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      void toolServerSyncingAction(slug).then((syncing) => {
        if (!syncing) router.refresh();
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [slug, router]);
  return null;
}

/** A tool's enabled switch, its effect, and "accept the new definition" when it drifted. */
export function ToolControls({ slug, tool }: { slug: string; tool: Tool }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const change = (request: Parameters<typeof updateToolAction>[2]) =>
    startTransition(async () => {
      const result = await updateToolAction(slug, tool.name, request);
      setError(result && !result.ok ? (result.error ?? "The change was refused.") : undefined);
      router.refresh();
    });
  const cannot = tool.exposedName === null || tool.removed;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={tool.enabled}
            disabled={pending || (cannot && !tool.enabled)}
            onChange={(event) => change({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2">
          Effect
          <select
            value={tool.effect}
            disabled={pending}
            onChange={(event) =>
              change({ effect: event.target.value === "read" ? "read" : "write" })
            }
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm"
          >
            <option value="read">read: may run again after a crash</option>
            <option value="write">write: never repeated</option>
          </select>
        </label>
        {tool.drifted ? (
          <button
            type="button"
            disabled={pending}
            className={buttonStyles.secondary}
            onClick={() => change({ acceptDefinition: true })}
          >
            Accept the new definition
          </button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
