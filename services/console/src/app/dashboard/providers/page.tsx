import type { Metadata } from "next";
import { EmptyState } from "../../_components/ui.tsx";
import { requireSession } from "../../_lib/session.ts";

export const metadata: Metadata = { title: "Model providers" };

export default async function ProvidersPage() {
  await requireSession();
  return (
    <EmptyState title="Bring your own model keys">
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
        <code className="rounded bg-raised px-1 py-0.5 font-mono text-xs text-fg">
          &lt;provider&gt;/&lt;model-id&gt;
        </code>{" "}
        and needs a key for that provider.
      </p>
    </EmptyState>
  );
}
