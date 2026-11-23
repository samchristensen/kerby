import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "../_components/client.tsx";
import { formatBytes, formatDate, quickstart } from "../_components/format.ts";
import { Badge, Card, CodeBlock, DetailList, PageHeader } from "../_components/ui.tsx";
import { consoleService } from "../_lib/console.ts";
import { requireSession } from "../_lib/session.ts";

export const metadata: Metadata = { title: "Overview" };

const planDefault = <span className="text-muted">Plan default</span>;

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          done ? "bg-live/10 text-live-text" : "bg-raised text-muted"
        }`}
      >
        {done ? (
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
          </svg>
        ) : (
          n
        )}
        <span className="sr-only">{done ? " (done)" : ""}</span>
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className={`text-sm font-medium ${done ? "text-muted line-through" : "text-fg"}`}>
          {title}
        </h3>
        <div className="mt-1 text-sm text-muted">{children}</div>
      </div>
    </li>
  );
}

export default async function OverviewPage() {
  const session = await requireSession();
  const overview = await consoleService().overview(session);
  const { limits } = overview;
  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <PageHeader title="Overview" description={`Welcome back, ${session.email}.`} />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Workspace">
            <DetailList
              items={[
                { term: "Name", value: <span className="font-medium">{overview.tenantName}</span> },
                {
                  term: "ID",
                  value: (
                    <span className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs">{overview.tenantId}</code>
                      <CopyButton value={overview.tenantId} />
                    </span>
                  ),
                },
                {
                  term: "Status",
                  value: (
                    <Badge tone={overview.status === "active" ? "live" : "neutral"}>
                      {overview.status}
                    </Badge>
                  ),
                },
                { term: "Plan", value: <span className="capitalize">{overview.plan}</span> },
                { term: "Created", value: formatDate(overview.createdAt) },
              ]}
            />
          </Card>
          <Card title="Limits">
            <DetailList
              items={[
                { term: "Concurrent turns", value: limits.maxConcurrentTurns ?? planDefault },
                {
                  term: "Requests per minute",
                  value: limits.requestsPerMinute?.toLocaleString("en-US") ?? planDefault,
                },
                {
                  term: "Storage",
                  value:
                    limits.storageBytes === undefined
                      ? planDefault
                      : formatBytes(limits.storageBytes),
                },
              ]}
            />
          </Card>
        </div>
        <div className="mt-6">
          <Card title="Get started">
            <ol className="space-y-6">
              <Step n={1} done={overview.modelKeys > 0} title="Add a model provider key">
                Kerby runs your conversations on your own model keys.{" "}
                <Link
                  href="/dashboard/providers"
                  className="font-medium text-brand-text hover:text-brand-text/80"
                >
                  Add a provider key →
                </Link>
              </Step>
              <Step n={2} done={overview.activeApiKeys > 0} title="Create an API key">
                API keys authenticate your calls to the tenant API.{" "}
                <Link
                  href="/dashboard/api-keys/new"
                  className="font-medium text-brand-text hover:text-brand-text/80"
                >
                  Create a key →
                </Link>
              </Step>
              <Step n={3} done={false} title="Call the API">
                <p className="mb-3">Start a conversation, send a message, and stream the reply.</p>
                <CodeBlock>{quickstart(overview.apiUrl)}</CodeBlock>
              </Step>
            </ol>
          </Card>
        </div>
      </div>
    </main>
  );
}
