import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  await requireSession();
  return (
    <EmptyState title="Integrations">
      <p>
        An integration is one system you connect to Kerby: a support bot, a back office, a nightly
        job. It holds the API keys that system uses, what those keys may do (scopes), and where its
        events are sent (subscriptions).
      </p>
      <p>
        Send a key with every request as{" "}
        <code className="rounded bg-raised px-1 py-0.5 font-mono text-xs text-fg">
          Authorization: Bearer kb_…
        </code>
        . Keys rotate within an integration; its scopes and subscriptions stay.
      </p>
      <div className="pt-2">
        <ButtonLink href="/dashboard/integrations/new">Create an integration</ButtonLink>
      </div>
    </EmptyState>
  );
}
