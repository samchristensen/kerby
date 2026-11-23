import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "../../../../../_components/ui.tsx";
import { consoleService } from "../../../../../_lib/console.ts";
import { requireSession } from "../../../../../_lib/session.ts";
import { Workspace } from "../../../../_components/panes.tsx";
import { createSubscriptionAction } from "../../../actions.ts";
import { NewSubscriptionForm } from "./form.tsx";

export const metadata: Metadata = { title: "New subscription" };

export default async function NewSubscriptionPage({
  params,
}: {
  params: Promise<{ integrationId: string }>;
}) {
  const session = await requireSession();
  const { integrationId } = await params;
  const service = consoleService();
  const integration = await service.integration(session, integrationId);
  if (!integration) notFound();
  const base = `/dashboard/integrations/${integration.id}`;
  return (
    <Workspace>
      <PageHeader
        title="New subscription"
        description={`Send ${integration.name}'s events to a webhook as they happen.`}
      />
      <NewSubscriptionForm
        action={createSubscriptionAction.bind(null, integration.id)}
        types={service.eventTypeOptions()}
        tenantScope={integration.scopes.includes("tenant")}
        cancelHref={base}
        subscriptionHref={`${base}/subscriptions`}
      />
    </Workspace>
  );
}
