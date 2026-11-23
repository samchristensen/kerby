import type { Metadata } from "next";
import { ButtonLink, EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  await requireSession();
  return (
    <EmptyState
      title="API keys"
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
        API keys authenticate your workspace to the tenant API. Send one with every request as{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-800">
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
