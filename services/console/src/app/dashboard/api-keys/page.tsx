import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  await requireSession();
  return (
    <EmptyState title="API keys">
      <p>
        API keys authenticate your workspace to the tenant API. Send one with every request as{" "}
        <code className="rounded bg-raised px-1 py-0.5 font-mono text-xs text-fg">
          Authorization: Bearer kb_…
        </code>
      </p>
      <p>
        A key is shown once, when you create it. You can revoke a key at any time; requests using it
        then fail.
      </p>
      <div className="pt-2">
        <ButtonLink href="/dashboard/api-keys/new">Create a key</ButtonLink>
      </div>
    </EmptyState>
  );
}
