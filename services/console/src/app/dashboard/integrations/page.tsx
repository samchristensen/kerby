import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  await requireSession();
  return (
    <EmptyState title="Integrations">
      <p>
        An integration is one client of your workspace: a backend, a script, a partner. It holds the
        API keys that client sends as{" "}
        <code className="rounded bg-raised px-1 py-0.5 font-mono text-xs text-fg">
          Authorization: Bearer kb_…
        </code>
        , and its role decides what those keys may do.
      </p>
      <p>
        A key is shown once, when you create it. Revoke a key, or archive a whole integration, and
        requests using it then fail.
      </p>
      <div className="pt-2">
        <ButtonLink href="/dashboard/integrations/new">Create an integration</ButtonLink>
      </div>
    </EmptyState>
  );
}
