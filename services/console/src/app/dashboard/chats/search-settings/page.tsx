import type { Metadata } from "next";
import Link from "next/link";
import { ConfirmAction } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Alert, Badge, Card, DetailList, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { providerName } from "../../../_lib/providers.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { clearEmbeddingModelAction, setEmbeddingModelAction } from "../actions.ts";
import { EmbeddingModelForm } from "./form.tsx";

export const metadata: Metadata = { title: "Search settings" };

export default async function SearchSettingsPage() {
  const access = await requireChatAccess();
  const settings = await consoleService().searchSettings(access);
  const provider = settings.embeddingModel?.split("/")[0];
  return (
    <Workspace>
      <PageHeader
        title="Search settings"
        description="Search in the chats pane finds the chats that mention your words. An embedding model adds the ones that mean the same."
        actions={
          settings.embeddingModel ? (
            <Badge tone="green">Words and meaning</Badge>
          ) : (
            <Badge tone="zinc">Words only</Badge>
          )
        }
      />
      <div className="space-y-6">
        <Card title="Index">
          <DetailList
            items={[
              {
                term: "Embedding model",
                value: settings.embeddingModel ? (
                  <code className="font-mono text-xs">{settings.embeddingModel}</code>
                ) : (
                  <span className="text-zinc-400">None: search by words only</span>
                ),
              },
              {
                term: "Indexed",
                value: settings.embeddingModel
                  ? `${settings.chunks} passages, ${settings.embedded} embedded`
                  : `${settings.chunks} passages`,
              },
              ...(settings.updatedAt
                ? [{ term: "Changed", value: formatDateTime(settings.updatedAt) }]
                : []),
            ]}
          />
          {settings.lastError ? (
            <div className="mt-4">
              <Alert tone="error">Embedding stopped: {settings.lastError}</Alert>
            </div>
          ) : null}
        </Card>
        <Card title="Embedding model">
          <div className="mb-4 space-y-3 text-sm text-zinc-500">
            <p>
              Setting a model sends the text of every chat in this workspace to its provider, with
              your key for that provider, to embed it; new messages follow as they are written.
              Searches with words and meaning send the query too. Choose a provider you are allowed
              to share your chats with.
            </p>
            <p>
              Changing the model embeds every chat again. Until that is done, search finds fewer
              chats by meaning.
            </p>
          </div>
          <EmbeddingModelForm
            key={settings.embeddingModel ?? ""}
            action={setEmbeddingModelAction}
            current={settings.embeddingModel}
            suggestions={settings.suggestions.map((suggestion) => suggestion.model)}
          />
          {settings.embeddingModel ? (
            <div className="mt-6 border-t border-zinc-100 pt-6">
              <ConfirmAction
                action={clearEmbeddingModelAction}
                label="Turn off"
                question={`Stop embedding with ${provider ? providerName(provider) : "this provider"}? Search keeps finding chats by their words.`}
                confirmLabel="Turn off"
              />
            </div>
          ) : null}
        </Card>
        <Card title="Suggested models">
          <ul className="divide-y divide-zinc-100">
            {settings.suggestions.map((suggestion) => (
              <li
                key={suggestion.model}
                className="flex items-center justify-between gap-4 py-3 text-sm first:pt-0 last:pb-0"
              >
                <span className="min-w-0">
                  <span className="block font-medium text-zinc-900">
                    {providerName(suggestion.provider)}
                  </span>
                  <code className="block truncate font-mono text-xs text-zinc-500">
                    {suggestion.model}
                  </code>
                </span>
                {suggestion.configured ? (
                  <Badge tone="green">Key set</Badge>
                ) : (
                  <Link
                    href={`/dashboard/providers/${suggestion.provider}`}
                    className="shrink-0 text-xs font-medium text-indigo-600 hover:text-indigo-500"
                  >
                    Add a key
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Workspace>
  );
}
