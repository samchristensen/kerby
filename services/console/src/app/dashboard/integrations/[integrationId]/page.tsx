import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmAction, CopyButton } from "../../../_components/client.tsx";
import { formatDate, formatDateTime } from "../../../_components/format.ts";
import { Badge, ButtonLink, Card, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import {
  createKeyAction,
  deleteIntegrationAction,
  revokeKeyAction,
  setScopesAction,
} from "../actions.ts";
import { NewKeyForm, ScopesForm } from "./forms.tsx";
import { SubscriptionState } from "./subscriptions/state.tsx";

export const metadata: Metadata = { title: "Integration" };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

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
  const subscriptions = await service.subscriptions(access, integration.id);
  const liveKeys = integration.keys.filter((key) => !key.revokedAt).length;
  const base = `/dashboard/integrations/${integration.id}`;

  return (
    <Workspace>
      <PageHeader
        title={integration.name}
        description={`Created ${formatDate(integration.createdAt)}`}
        actions={
          <span className="flex items-center gap-2">
            <code className="font-mono text-xs text-zinc-500">{integration.id}</code>
            <CopyButton value={integration.id} label="Copy ID" />
          </span>
        }
      />
      <div className="space-y-6">
        <Card title="Scopes">
          <p className="mb-4 text-sm text-zinc-500">
            What this integration's keys may do. A request that needs a scope it lacks is refused
            with 403.
          </p>
          <ScopesForm
            action={setScopesAction.bind(null, integration.id)}
            options={service.scopeOptions()}
            scopes={integration.scopes}
          />
        </Card>

        <Card title="API keys">
          {integration.keys.length === 0 ? (
            <p className="mb-4 text-sm text-zinc-500">No keys yet.</p>
          ) : (
            <ul className="mb-5 divide-y divide-zinc-100">
              {integration.keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm">
                      <span
                        className={key.label ? "font-medium text-zinc-900" : "text-zinc-500 italic"}
                      >
                        {key.label || "Untitled key"}
                      </span>
                      {key.revokedAt ? (
                        <Badge tone="zinc">Revoked</Badge>
                      ) : (
                        <Badge tone="green">Active</Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      <code className="font-mono">kb_{key.id}_…</code> · created{" "}
                      {formatDate(key.createdAt)} ·{" "}
                      {key.revokedAt
                        ? `revoked ${formatDateTime(key.revokedAt)}`
                        : key.lastUsedAt
                          ? `last used ${formatDateTime(key.lastUsedAt)}`
                          : "never used"}
                    </p>
                  </div>
                  {key.revokedAt ? null : (
                    <ConfirmAction
                      action={revokeKeyAction.bind(null, key.id)}
                      label="Revoke"
                      question="Revoke this key? Requests using it will fail."
                      confirmLabel="Revoke key"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          <NewKeyForm action={createKeyAction.bind(null, integration.id)} />
        </Card>

        <Card
          title="Event subscriptions"
          actions={
            <ButtonLink href={`${base}/subscriptions/new`} variant="secondary">
              New subscription
            </ButtonLink>
          }
        >
          {subscriptions.length === 0 ? (
            <p className="text-sm text-zinc-500">
              None yet. A subscription sends this integration's events to a webhook as they happen,
              signed so your endpoint can check they came from Kerby.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {subscriptions.map((subscription) => (
                <li key={subscription.id} className="py-3 first:pt-0 last:pb-0">
                  <Link
                    href={`${base}/subscriptions/${subscription.id}`}
                    className="block rounded-md hover:bg-zinc-50"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <code className="truncate font-mono text-sm text-zinc-900">
                        {subscription.destination.url}
                      </code>
                      <SubscriptionState subscription={subscription} />
                    </span>
                    <span className="mt-1 block truncate text-xs text-zinc-500">
                      {subscription.description ? `${subscription.description} · ` : ""}
                      {subscription.types.join(", ")} ·{" "}
                      {subscription.scope === "tenant" ? "whole workspace" : "own events"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Danger zone">
          <p className="mb-4 text-sm text-zinc-500">
            Deleting an integration revokes its keys and deletes its subscriptions, at once and for
            good. Conversations it started stay.
          </p>
          <ConfirmAction
            action={deleteIntegrationAction.bind(null, integration.id)}
            label="Delete integration"
            question={`Delete ${integration.name}? ${plural(liveKeys, "key")} will be revoked and ${plural(subscriptions.length, "subscription")} deleted.`}
            confirmLabel="Delete"
          />
        </Card>
      </div>
    </Workspace>
  );
}
