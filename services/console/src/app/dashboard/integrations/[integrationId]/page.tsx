import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmAction } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Badge, Card, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import {
  archiveIntegrationAction,
  createApiKeyAction,
  revokeApiKeyAction,
  setIntegrationToolsAction,
  updateIntegrationAction,
} from "../actions.ts";
import { NewKeyForm } from "./key-form.tsx";
import { IntegrationSettingsForm } from "./settings-form.tsx";
import { ToolGrantsForm } from "./tools-form.tsx";

export const metadata: Metadata = { title: "Integration" };

export default async function IntegrationPage({
  params,
}: {
  params: Promise<{ integrationId: string }>;
}) {
  const access = await requireChatAccess();
  const { integrationId } = await params;
  const service = consoleService();
  const integration = await service.integration(access.session, integrationId);
  if (!integration) notFound();
  // Only a restricted integration's grants matter; an admin holds every tool.
  const tools =
    integration.role === "restricted"
      ? await Promise.all([
          service.availableTools(access),
          service.toolServers(access),
          service.integrationTools(access, integration.id),
        ])
      : undefined;
  return (
    <Workspace>
      <PageHeader
        title={integration.name}
        description={`Created ${formatDateTime(integration.createdAt)}`}
        actions={
          <Badge tone={integration.role === "admin" ? "brand" : "neutral"}>
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
        <Card title="Tools">
          {tools ? (
            <>
              <p className="mb-4 text-sm text-muted">
                The tools its keys may name on a conversation. A conversation naming any other tool
                is refused.
              </p>
              <ToolGrantsForm
                action={setIntegrationToolsAction.bind(null, integration.id)}
                available={tools[0]}
                servers={tools[1].map((server) => server.slug)}
                granted={tools[2] ?? []}
              />
            </>
          ) : (
            <p className="text-sm text-muted">
              An admin integration holds every tool: its keys may name any enabled tool.
            </p>
          )}
        </Card>
        <Card title="API keys">
          {integration.keys.length === 0 ? (
            <p className="mb-4 text-sm text-muted">No keys yet.</p>
          ) : (
            <ul className="mb-6 divide-y divide-line">
              {integration.keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${key.label ? "text-fg" : "text-muted italic"}`}
                    >
                      {key.label || "Untitled key"}
                    </span>
                    <span className="block text-xs text-muted">
                      <code className="font-mono">kb_{key.id}_…</code> · created{" "}
                      {formatDateTime(key.createdAt)} · last used{" "}
                      {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "never"}
                    </span>
                  </span>
                  {key.revokedAt ? (
                    <Badge tone="neutral">Revoked</Badge>
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
          <p className="mb-4 text-sm text-muted">
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
