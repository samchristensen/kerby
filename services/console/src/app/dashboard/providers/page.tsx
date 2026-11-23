import type { Metadata } from "next";
import { EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Model providers" };

export default async function ProvidersPage() {
  await requireSession();
  return (
    <EmptyState
      title="Bring your own model keys"
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
            strokeLinejoin="round"
            d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Zm0 0v18M4 7.5l8 4.5 8-4.5"
          />
        </svg>
      }
    >
      <p>
        Kerby holds no model keys of its own: your conversations run on yours. Pick a provider to
        add a key.
      </p>
      <p>
        A stored key is sealed to a public key, so the API can store it but never read it back. Only
        the worker opens it, inside the run that uses it.
      </p>
      <p>
        A conversation names its model as{" "}
        <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs text-zinc-800">
          &lt;provider&gt;/&lt;model-id&gt;
        </code>{" "}
        and needs a key for that provider.
      </p>
    </EmptyState>
  );
}
