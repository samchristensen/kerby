import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  await requireSession();
  return (
    <EmptyState
      title="Integrations"
      icon={
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-6"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7Z"
          />
        </svg>
      }
    >
      <p>
        An integration is one system you connect to Kerby: a support bot, a back office, a nightly
        job. It holds the API keys that system uses, what those keys may do (scopes), and where its
        events are sent (subscriptions).
      </p>
      <p>
        Send a key with every request as{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-800">
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
