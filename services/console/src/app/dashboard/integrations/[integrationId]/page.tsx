import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmAction } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Badge, Card, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import {
  archiveIntegrationAction,
  createApiKeyAction,
  revokeApiKeyAction,
  updateIntegrationAction,
} from "../actions.ts";
import { NewKeyForm } from "./key-form.tsx";
import { IntegrationSettingsForm } from "./settings-form.tsx";

export const metadata: Metadata = { title: "Integration" };

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ integrationId: string }>;
}) {
  const session = await requireSession();
  const { integrationId } = await params;
  const integration = await consoleService().integration(session, integrationId);
  if (!integration) notFound();
  return (
    <Workspace>
      <PageHeader
        title={integration.name}
        description={`Created ${formatDateTime(integration.createdAt)}`}
        actions={
          <Badge tone={integration.role === "admin" ? "indigo" : "zinc"}>
            {integration.role === "admin" ? "Admin" : "Restricted"}
          </Badge>
        }
      />
      <div className="space-y-6">
        <Card title="Settings">
          <IntegrationSettingsForm
            action={updateIntegrationAction.bind(null, integration.id)}
            name={integration.name}
            role={integration.role}
          />
        </Card>
        <Card title="API keys">
          {integration.keys.length === 0 ? (
            <p className="mb-4 text-sm text-zinc-500">No keys yet.</p>
          ) : (
            <ul className="mb-6 divide-y divide-zinc-100">
              {integration.keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${key.label ? "text-zinc-900" : "text-zinc-500 italic"}`}
                    >
                      {key.label || "Untitled key"}
                    </span>
                    <span className="block text-xs text-zinc-500">
                      <code className="font-mono">kb_{key.id}_…</code> · created{" "}
                      {formatDateTime(key.createdAt)} · last used{" "}
                      {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "never"}
                    </span>
                  </span>
                  {key.revokedAt ? (
                    <Badge tone="zinc">Revoked</Badge>
                  ) : (
                    <ConfirmAction
                      action={revokeApiKeyAction.bind(null, key.id)}
                      label="Revoke"
                      question="Revoke this key? Requests using it will fail."
                      confirmLabel="Revoke key"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <NewKeyForm action={createApiKeyAction.bind(null, integration.id)} />
        </Card>
        <Card title="Danger zone">
          <p className="mb-4 text-sm text-zinc-500">
            Archiving revokes every key of this integration at once and for good, and frees its
            name.
          </p>
          <ConfirmAction
            action={archiveIntegrationAction.bind(null, integration.id)}
            label="Archive integration"
            question={`Archive ${integration.name}? Its ${integration.liveKeys} live key(s) stop working.`}
            confirmLabel="Archive"
          />
        </Card>
      </div>
    </Workspace>
  );
}
