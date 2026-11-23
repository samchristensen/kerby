import type { DeliveryAttempt } from "@kerby/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmAction, CopyButton } from "../../../../../_components/client.tsx";
import { formatDateTime } from "../../../../../_components/format.ts";
import { Badge, Card, DetailList, PageHeader } from "../../../../../_components/ui.tsx";
import { consoleService } from "../../../../../_lib/console.ts";
import { requireChatAccess } from "../../../../../_lib/session.ts";
import { Workspace } from "../../../../_components/panes.tsx";
import { ButtonAction } from "../../../_components/button-action.tsx";
import {
  deleteSubscriptionAction,
  rotateSecretAction,
  setSubscriptionEnabledAction,
  testSubscriptionAction,
} from "../../../actions.ts";
import { SubscriptionState } from "../state.tsx";

export const metadata: Metadata = { title: "Subscription" };

const outcomeTone = { delivered: "live", failed: "danger", gone: "neutral" } as const;

function Outcome({ delivery }: { delivery: DeliveryAttempt }) {
  return <Badge tone={outcomeTone[delivery.outcome]}>{delivery.outcome}</Badge>;
}

const muted = (text: string) => <span className="text-muted">{text}</span>;

export default async function SubscriptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ integrationId: string; subscriptionId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const access = await requireChatAccess();
  const { integrationId, subscriptionId } = await params;
  const { before } = await searchParams;
  const service = consoleService();
  const subscription = await service.subscription(access, subscriptionId);
  // Under another integration's address it is not found, as an id that does not exist.
  if (!subscription || subscription.integrationId !== integrationId) notFound();
  const log = await service.deliveries(access, subscription.id, before);
  if (!log) notFound();
  const page = `/dashboard/integrations/${integrationId}/subscriptions/${subscription.id}`;
  const enabled = subscription.state === "active";

  return (
    <Workspace>
      <p className="mb-2 text-sm">
        <Link
          href={`/dashboard/integrations/${integrationId}`}
          className="font-medium text-brand-text hover:text-brand-text/80"
        >
          ← Integration
        </Link>
      </p>
      <PageHeader
        title={subscription.description || "Webhook subscription"}
        actions={<SubscriptionState subscription={subscription} />}
      />
      <div className="space-y-6">
        <Card title="Details">
          <DetailList
            items={[
              {
                term: "Endpoint",
                value: (
                  <span className="flex items-center gap-2">
                    <code className="truncate font-mono text-xs">
                      {subscription.destination.url}
                    </code>
                    <CopyButton value={subscription.destination.url} />
                  </span>
                ),
              },
              {
                term: "Event types",
                value: <code className="font-mono text-xs">{subscription.types.join(", ")}</code>,
              },
              {
                term: "Whose events",
                value:
                  subscription.scope === "tenant" ? "The whole workspace" : "This integration's",
              },
              { term: "State", value: enabled ? "Active" : "Disabled" },
              ...(subscription.disabledReason
                ? [{ term: "Disabled because", value: subscription.disabledReason }]
                : []),
              {
                term: "Failing since",
                value: subscription.failingSince
                  ? formatDateTime(subscription.failingSince)
                  : muted("Healthy"),
              },
              { term: "Created", value: formatDateTime(subscription.createdAt) },
              {
                term: "ID",
                value: (
                  <span className="flex items-center gap-2">
                    <code className="truncate font-mono text-xs">{subscription.id}</code>
                    <CopyButton value={subscription.id} />
                  </span>
                ),
              },
            ]}
          />
        </Card>

        <Card title="Manage">
          <div className="space-y-5">
            <div>
              <p className="mb-2 text-sm text-muted">
                {enabled
                  ? "Disabling stops deliveries; enabling again resumes where it stopped, so no event in the 30 days kept is skipped."
                  : "Enabling resumes where it stopped: events since then are delivered, up to the 30 days kept."}
              </p>
              <ButtonAction
                action={setSubscriptionEnabledAction.bind(null, subscription.id, !enabled)}
                label={enabled ? "Disable" : "Enable"}
                pending={enabled ? "Disabling…" : "Enabling…"}
              />
            </div>
            <div>
              <p className="mb-2 text-sm text-muted">
                Send a <code className="font-mono">ping</code> event to the endpoint now.
              </p>
              <ButtonAction
                action={testSubscriptionAction.bind(null, subscription.id)}
                label="Send test"
                pending="Sending…"
              />
            </div>
            <div>
              <p className="mb-2 text-sm text-muted">
                A new signing secret, shown once. The old one keeps signing beside it for 24 hours.
              </p>
              <ButtonAction
                action={rotateSecretAction.bind(null, subscription.id)}
                label="Rotate secret"
                pending="Rotating…"
                secretNoun="signing secret"
              />
            </div>
            <div className="border-t border-line pt-5">
              <ConfirmAction
                action={deleteSubscriptionAction.bind(null, integrationId, subscription.id)}
                label="Delete subscription"
                question="Delete this subscription? Nothing more is sent to the endpoint, and its delivery log goes with it."
                confirmLabel="Delete"
              />
            </div>
          </div>
        </Card>

        <Card title="Delivery log">
          {log.deliveries.length === 0 ? (
            <p className="text-sm text-muted">
              {before ? "No older attempts." : "Nothing delivered yet."}
            </p>
          ) : (
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="px-5 py-2 font-medium">When</th>
                    <th className="px-2 py-2 font-medium">Outcome</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Attempt</th>
                    <th className="px-2 py-2 font-medium">Retry</th>
                    <th className="px-5 py-2 font-medium">Error / response</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line align-top">
                  {log.deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td className="whitespace-nowrap px-5 py-2.5 text-muted">
                        {formatDateTime(delivery.at)}
                        <span className="block text-xs text-muted">{delivery.durationMs} ms</span>
                      </td>
                      <td className="px-2 py-2.5">
                        <Outcome delivery={delivery} />
                      </td>
                      <td className="px-2 py-2.5 font-mono text-xs">
                        {delivery.status ?? muted("—")}
                      </td>
                      <td className="px-2 py-2.5">{delivery.attempt}</td>
                      <td className="px-2 py-2.5">{delivery.willRetry ? "Yes" : muted("No")}</td>
                      <td className="max-w-xs px-5 py-2.5">
                        {delivery.error ? (
                          <p className="break-words text-danger">{delivery.error}</p>
                        ) : null}
                        {delivery.response ? (
                          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-1.5 font-mono text-xs text-muted">
                            {delivery.response}
                          </pre>
                        ) : null}
                        <p className="mt-1 truncate font-mono text-xs text-muted">
                          {delivery.eventIds.join(", ")}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex gap-4 text-sm">
            {before ? (
              <Link href={page} className="font-medium text-brand-text hover:text-brand-text/80">
                ← Newest
              </Link>
            ) : null}
            {log.nextBefore ? (
              <Link
                href={`${page}?before=${log.nextBefore}`}
                className="font-medium text-brand-text hover:text-brand-text/80"
              >
                Older →
              </Link>
            ) : null}
          </div>
        </Card>
      </div>
    </Workspace>
  );
}
