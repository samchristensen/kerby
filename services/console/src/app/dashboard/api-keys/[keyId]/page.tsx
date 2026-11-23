import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmAction, CopyButton } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Badge, Card, DetailList, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { revokeApiKeyAction } from "../actions.ts";

export const metadata: Metadata = { title: "API key" };

export default async function ApiKeyPage({ params }: { params: Promise<{ keyId: string }> }) {
  const session = await requireSession();
  const { keyId } = await params;
  const key = (await consoleService().apiKeys(session)).find((candidate) => candidate.id === keyId);
  if (!key) notFound();
  return (
    <Workspace>
      <PageHeader
        title={key.label || "Untitled key"}
        actions={
          key.revokedAt ? <Badge tone="zinc">Revoked</Badge> : <Badge tone="green">Active</Badge>
        }
      />
      <Card title="Details">
        <DetailList
          items={[
            {
              term: "Key ID",
              value: (
                <span className="flex items-center gap-2">
                  <code className="truncate font-mono text-xs">{key.id}</code>
                  <CopyButton value={key.id} />
                </span>
              ),
            },
            { term: "Prefix", value: <code className="font-mono text-xs">kb_{key.id}_…</code> },
            { term: "Created", value: formatDateTime(key.createdAt) },
            {
              term: "Last used",
              value: key.lastUsedAt ? (
                formatDateTime(key.lastUsedAt)
              ) : (
                <span className="text-zinc-400">Never</span>
              ),
            },
            {
              term: "Status",
              value: key.revokedAt ? `Revoked ${formatDateTime(key.revokedAt)}` : "Active",
            },
          ]}
        />
      </Card>
      {key.revokedAt ? null : (
        <div className="mt-6">
          <Card title="Danger zone">
            <p className="mb-4 text-sm text-zinc-500">
              Revoking a key is immediate and permanent. Requests that use it will be refused.
            </p>
            <ConfirmAction
              action={revokeApiKeyAction.bind(null, key.id)}
              label="Revoke key"
              question="Revoke this key? Requests using it will fail."
              confirmLabel="Confirm"
            />
          </Card>
        </div>
      )}
    </Workspace>
  );
}
