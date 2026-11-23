"use client";
// The forms of the Tools pages: adding a server, changing its address and auth, replacing its credential, connecting
// an OAuth server and finishing that connection, listing its tools again, each tool's switches, and the refresh while
// a worker lists the tools.
import type { Tool, ToolServerAuth } from "@kerby/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { FormFailure } from "../../../types/index.ts";
import { SubmitButton } from "../../_components/client.tsx";
import { Field } from "../../_components/field.tsx";
import { Alert, buttonStyles, Card } from "../../_components/ui.tsx";
import {
  createToolServerAction,
  finishToolServerOAuthAction,
  type NewServerState,
  type ToolFormState,
  toolServerSyncingAction,
  updateToolAction,
} from "./actions.ts";

const AUTH_LABELS: Record<ToolServerAuth["kind"], string> = {
  none: "None",
  header: "A credential in a header",
  oauth: "OAuth (connect in the browser)",
};

/**
 * No auth, a credential sent in one header, or OAuth. The credential is never shown: blank keeps the stored one on a
 * change. An OAuth server is connected from its page once saved.
 */
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
      <legend className="text-sm font-medium text-fg">Authentication</legend>
      <div className="flex gap-6 text-sm">
        {(["none", "header", "oauth"] as const).map((option) => (
          <label key={option} className="flex items-center gap-2">
            <input
              type="radio"
              name="auth"
              value={option}
              checked={kind === option}
              onChange={() => setKind(option)}
            />
            {AUTH_LABELS[option]}
          </label>
        ))}
      </div>
      {fields?.auth ? <p className="text-sm text-danger">{fields.auth}</p> : null}
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
      {kind === "oauth" ? (
        <Field
          label="Scope"
          name="scope"
          maxLength={1000}
          autoComplete="off"
          defaultValue={auth?.kind === "oauth" ? auth.scope : undefined}
          placeholder="Leave blank for what the server asks for"
          hint="Space-separated scopes to ask for. After saving, connect it from its page: you approve Kerby at the server's sign-in, once for the whole workspace."
          error={fields?.scope}
        />
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
      : state?.values.auth === "oauth"
        ? state.values.scope
          ? { kind: "oauth", scope: state.values.scope }
          : { kind: "oauth" }
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
          hint="Its MCP endpoint (Streamable HTTP). A server with a credential or OAuth must use https."
          error={state?.fields?.url}
        />
        <AuthFields
          key={state?.values.auth ?? "none"}
          auth={auth}
          hasCredential={false}
          fields={state?.fields}
        />
        <p className="text-sm text-muted">
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

/** Connect (or reconnect) an OAuth server: the browser leaves for its authorization server and comes back here. */
export function ConnectButton({
  action,
  connected,
}: {
  action: () => Promise<ToolFormState>;
  connected: boolean;
}) {
  const [state, formAction] = useActionState<ToolFormState, FormData>(action, undefined);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant={connected ? "secondary" : "primary"} pending="Opening the sign-in…">
        {connected ? "Reconnect" : "Connect"}
      </SubmitButton>
      {state && !state.ok ? <span className="text-sm text-danger">{state.error}</span> : null}
    </form>
  );
}

/**
 * The callback's work: hand the authorization server's answer to the api once (the action goes on to the server's
 * page), and show why if it was refused.
 */
export function FinishConnection({ answer }: { answer: Record<string, string> }) {
  const started = useRef(false);
  const [failure, setFailure] = useState<FormFailure | undefined>();
  useEffect(() => {
    // Once: the answer's state can finish a connection only once (development mounts effects twice).
    if (started.current) return;
    started.current = true;
    void finishToolServerOAuthAction(answer).then(setFailure);
  }, [answer]);
  if (!failure) return <p className="text-sm text-muted">Finishing the connection…</p>;
  return (
    <div className="space-y-4">
      <Alert tone="error">{failure.error ?? "The connection was refused."}</Alert>
      <Link href="/dashboard/tools" className="text-sm text-brand-text hover:underline">
        Back to Tools
      </Link>
    </div>
  );
}

export function SyncButton({ action }: { action: () => Promise<ToolFormState> }) {
  const [state, formAction] = useActionState<ToolFormState, FormData>(action, undefined);
  return (
    <form action={formAction} className="flex items-center gap-3">
      <SubmitButton variant="secondary" pending="Asking…">
        List tools again
      </SubmitButton>
      {state && !state.ok ? <span className="text-sm text-danger">{state.error}</span> : null}
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

/**
 * A tool's enabled switch, its effect, and "accept the new definition" when it drifted. Enabling and accepting send
 * the hash of the definition this page shows, so the api refuses them when the server lists another one since.
 */
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
            onChange={(event) =>
              change(
                event.target.checked
                  ? { enabled: true, expectedDefinition: tool.listedHash }
                  : { enabled: false },
              )
            }
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
            className="rounded-md border border-line bg-page px-2 py-1 text-sm text-fg"
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
            onClick={() => change({ acceptDefinition: true, expectedDefinition: tool.listedHash })}
          >
            Accept the new definition
          </button>
        ) : null}
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}
