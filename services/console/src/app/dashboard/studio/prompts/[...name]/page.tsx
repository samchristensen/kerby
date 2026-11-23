import type { Prompt, PromptVersion } from "@kerby/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { formatDateTime } from "../../../../_components/format.ts";
import { Badge, Card, CodeBlock, DetailList } from "../../../../_components/ui.tsx";
import { consoleService } from "../../../../_lib/console.ts";
import { requireChatAccess } from "../../../../_lib/session.ts";
import { ChatDraftEditor } from "../../_components/chat-editor.tsx";
import { ChatPlayground } from "../../_components/chat-playground.tsx";
import { DecisionDraftEditor } from "../../_components/decision-editor.tsx";
import { DecisionPlayground } from "../../_components/decision-playground.tsx";
import { LabelsEditor } from "../../_components/labels.tsx";
import { ManagePrompt } from "../../_components/manage.tsx";

export const metadata: Metadata = { title: "Studio" };

const VIEWS = [
  { view: "draft", label: "Draft" },
  { view: "versions", label: "Versions" },
  { view: "playground", label: "Playground" },
] as const;

/** `user:<id>` or `key:<id>`, as a person reads it. */
const actor = (who: string) =>
  who.startsWith("user:") ? "a person in the console" : who.startsWith("key:") ? "an API key" : who;

function VersionBody({ version }: { version: PromptVersion }) {
  const { body } = version;
  const items = [
    {
      term: "Published",
      value: `${formatDateTime(version.publishedAt)} by ${actor(version.publishedBy)}`,
    },
    { term: "Note", value: version.note ?? "—" },
    { term: "Model", value: <code className="font-mono">{body.model ?? "default"}</code> },
  ];
  if (body.kind === "decision") {
    return (
      <div className="space-y-4">
        <DetailList items={items} />
        <h3 className="text-sm font-semibold text-zinc-900">Questions</h3>
        <CodeBlock>{JSON.stringify(body.questions, null, 2)}</CodeBlock>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <DetailList
        items={[
          ...items,
          {
            term: "Variables",
            value:
              body.variables.length === 0
                ? "none"
                : body.variables
                    .map((v) => (v.default === undefined ? `${v.name} (required)` : v.name))
                    .join(", "),
          },
          { term: "Guardrails", value: body.guardrails.map((g) => g.name).join(", ") || "none" },
        ]}
      />
      <h3 className="text-sm font-semibold text-zinc-900">Text</h3>
      <CodeBlock>{body.text}</CodeBlock>
      {body.guardrails.length > 0 ? (
        <>
          <h3 className="text-sm font-semibold text-zinc-900">Guardrails</h3>
          <CodeBlock>{JSON.stringify(body.guardrails, null, 2)}</CodeBlock>
        </>
      ) : null}
    </div>
  );
}

function Versions({
  prompt,
  base,
  open,
}: {
  prompt: Prompt;
  base: string;
  open: PromptVersion | undefined;
}) {
  if (prompt.versions.length === 0) {
    return (
      <Card>
        <p className="text-sm text-zinc-500">
          Nothing published yet. Publish the draft to make version 1.
        </p>
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      {open ? (
        <Card
          title={`Version ${open.version}`}
          actions={
            <Link
              href={`${base}?view=versions`}
              className="text-sm text-indigo-600 hover:underline"
            >
              Close
            </Link>
          }
        >
          <VersionBody version={open} />
        </Card>
      ) : null}
      <Card title="Labels">
        <LabelsEditor
          name={prompt.name}
          labels={prompt.labels}
          latestVersion={prompt.latestVersion ?? 0}
        />
      </Card>
      <Card title="Versions">
        <ul className="divide-y divide-zinc-100">
          {prompt.versions.map((v) => (
            <li
              key={v.version}
              className="flex flex-wrap items-baseline justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span className="min-w-0">
                <Link
                  href={`${base}?view=versions&v=${v.version}`}
                  className="font-medium text-indigo-600 hover:underline"
                >
                  v{v.version}
                </Link>
                <span className="ml-2 text-sm text-zinc-700">{v.note ?? ""}</span>
              </span>
              <span className="text-xs text-zinc-500">
                {formatDateTime(v.publishedAt)} · {actor(v.publishedBy)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export default async function PromptPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string[] }>;
  searchParams: Promise<{ view?: string; v?: string }>;
}) {
  const access = await requireChatAccess();
  const name = (await params).name.join("/");
  const { view: requested, v } = await searchParams;
  const service = consoleService();
  const prompt = await service.prompt(access, name);
  if (!prompt) notFound();
  const view = VIEWS.find((item) => item.view === requested)?.view ?? "draft";
  const base = `/dashboard/studio/prompts/${prompt.name}`;

  let body: ReactNode;
  if (view === "versions") {
    const open = v ? await service.promptVersion(access, prompt.name, v) : undefined;
    body = <Versions prompt={prompt} base={base} open={open} />;
  } else if (view === "playground") {
    body =
      prompt.kind === "chat" ? (
        <ChatPlayground prompt={prompt} />
      ) : (
        <DecisionPlayground prompt={prompt} />
      );
  } else {
    const providers = (await service.providers(access.session))
      .filter((p) => p.configured && (prompt.kind === "chat" ? p.chat : p.decisions))
      .map((p) => p.id);
    body = (
      <div className="space-y-6">
        {prompt.draft.kind === "chat" ? (
          <ChatDraftEditor
            key={prompt.draftRevision}
            name={prompt.name}
            revision={prompt.draftRevision}
            draft={prompt.draft}
            providers={providers}
            tools={await service.availableTools(access)}
          />
        ) : (
          <DecisionDraftEditor
            key={prompt.draftRevision}
            name={prompt.name}
            revision={prompt.draftRevision}
            draft={prompt.draft}
            providers={providers}
          />
        )}
        {prompt.latestVersion === null ? <ManagePrompt name={prompt.name} /> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-lg font-semibold text-zinc-900">{prompt.name}</h1>
        <Badge tone="zinc">{prompt.kind === "chat" ? "Chat prompt" : "Decision model"}</Badge>
        {prompt.latestVersion === null ? (
          <Badge tone="zinc">unpublished</Badge>
        ) : (
          <Badge tone="green">latest v{prompt.latestVersion}</Badge>
        )}
        {Object.entries(prompt.labels).map(([label, version]) => (
          <Badge key={label} tone="indigo">
            {label}·v{version}
          </Badge>
        ))}
      </div>
      <nav aria-label="Prompt" className="mb-6 flex gap-1 border-b border-zinc-200">
        {VIEWS.map((item) => (
          <Link
            key={item.view}
            href={`${base}?view=${item.view}`}
            aria-current={view === item.view ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              view === item.view
                ? "border-indigo-600 text-indigo-700"
                : "border-transparent text-zinc-600 hover:text-zinc-900"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
