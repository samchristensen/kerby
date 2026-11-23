import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmAction } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Badge, Card, CodeBlock, DetailList, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { providerName } from "../../../_lib/providers.ts";
import { requireSession } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import { removeModelKeyAction, setModelKeyAction } from "../actions.ts";
import { ModelKeyForm } from "./form.tsx";

export const metadata: Metadata = { title: "Model provider" };

/** What a provider's key is used for, in words. */
const uses = (provider: { chat: boolean; decisions: boolean }): string =>
  provider.chat && provider.decisions
    ? "chats and decisions"
    : provider.decisions
      ? "decisions (judgments and guardrails)"
      : "chats";

const removeConsequence = (provider: { chat: boolean; decisions: boolean }): string =>
  provider.chat && provider.decisions
    ? "Conversations and decisions on its models will fail"
    : provider.decisions
      ? "Decisions on its models will fail"
      : "Conversations on its models will fail";
export default async function ProviderPage({ params }: { params: Promise<{ provider: string }> }) {
  const session = await requireSession();
  const { provider: id } = await params;
  const provider = (await consoleService().providers(session)).find(
    (candidate) => candidate.id === id,
  );
  if (!provider) notFound();
  const name = providerName(provider.id);
  return (
    <Workspace>
      <PageHeader
        title={name}
        description={`Model ids for this provider start with ${provider.id}/. It runs ${uses(provider)}.`}
        actions={
          provider.configured ? (
            <Badge tone="green">Key set</Badge>
          ) : (
            <Badge tone="zinc">No key</Badge>
          )
        }
      />
      <div className="space-y-6">
        <Card title="Details">
          <DetailList
            items={[
              {
                term: "Provider ID",
                value: <code className="font-mono text-xs">{provider.id}</code>,
              },
              {
                term: "Status",
                value:
                  provider.configured && provider.updatedAt ? (
                    `Key set ${formatDateTime(provider.updatedAt)}`
                  ) : provider.configured ? (
                    "Key set"
                  ) : (
                    <span className="text-zinc-400">No key</span>
                  ),
              },
            ]}
          />
        </Card>
        <Card title={provider.configured ? "Replace key" : "Add key"}>
          <ModelKeyForm action={setModelKeyAction.bind(null, provider.id)} providerName={name} />
          {provider.configured ? (
            <div className="mt-6 border-t border-zinc-100 pt-6">
              <ConfirmAction
                action={removeModelKeyAction.bind(null, provider.id)}
                label="Remove key"
                question={`Remove the ${name} key? ${removeConsequence(provider)} until you add one again.`}
                confirmLabel="Remove"
              />
            </div>
          ) : null}
        </Card>
        <Card title="Usage">
          {provider.chat ? (
            <>
              <p className="mb-3 text-sm text-zinc-500">
                Name the model when you start a conversation:
              </p>
              <CodeBlock>{`{"model": "${provider.id}/<model-id>"}`}</CodeBlock>
            </>
          ) : null}
          {provider.decisions ? (
            <>
              <p className={`${provider.chat ? "mt-6 " : ""}mb-3 text-sm text-zinc-500`}>
                Name the model of a decision (
                <code className="font-mono text-xs">POST /v1/judgments</code>, or a guardrail's{" "}
                <code className="font-mono text-xs">model</code>):
              </p>
              <CodeBlock>{`{"model": "${provider.id}/<model-id>"}`}</CodeBlock>
            </>
          ) : null}
        </Card>
      </div>
    </Workspace>
  );
}
