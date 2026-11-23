import type { Tool, ToolDefinition } from "@kerby/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmAction } from "../../../_components/client.tsx";
import { formatDateTime } from "../../../_components/format.ts";
import { Alert, Badge, Card, CodeBlock, DetailList, PageHeader } from "../../../_components/ui.tsx";
import { consoleService } from "../../../_lib/console.ts";
import { requireChatAccess } from "../../../_lib/session.ts";
import { Workspace } from "../../_components/panes.tsx";
import {
  connectToolServerAction,
  deleteToolServerAction,
  replaceToolCredentialAction,
  syncToolServerAction,
  updateToolServerAction,
} from "../actions.ts";
import {
  ConnectButton,
  CredentialForm,
  EditServerForm,
  RefreshWhileSyncing,
  SyncButton,
  ToolControls,
} from "../server-forms.tsx";
import { ServerStatus, toolCounts } from "../status.tsx";

export const metadata: Metadata = { title: "Tool server" };

function Definition({ title, definition }: { title: string; definition: ToolDefinition }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs font-medium text-muted">{title}</p>
      {definition.title ? <p className="text-sm font-medium">{definition.title}</p> : null}
      <p className="text-sm whitespace-pre-wrap text-fg">{definition.description}</p>
      <CodeBlock>{JSON.stringify(definition.inputSchema, null, 2)}</CodeBlock>
    </div>
  );
}

function ToolItem({ slug, tool, builtin }: { slug: string; tool: Tool; builtin: boolean }) {
  const readOnlyHint = tool.definition.annotations?.readOnlyHint;
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-medium text-fg">{tool.name}</code>
        {tool.exposedName ? (
          <span className="text-xs text-muted">
            the model calls it <code className="font-mono">{tool.exposedName}</code>
          </span>
        ) : (
          <span className="text-xs text-danger">
            cannot be used: providers refuse the name{" "}
            <code className="font-mono">
              {slug}__{tool.name}
            </code>{" "}
            (more than 64 characters, or a character other than A-Z, a-z, 0-9, _ and -)
          </span>
        )}
        {tool.removed ? <Badge tone="danger">Removed</Badge> : null}
        {tool.drifted ? <Badge tone="danger">Drifted</Badge> : null}
        {builtin ? null : tool.enabled ? (
          <Badge tone="live">Enabled</Badge>
        ) : (
          <Badge tone="neutral">Disabled</Badge>
        )}
      </div>
      {tool.definition.title ? (
        <p className="text-sm font-medium text-fg">{tool.definition.title}</p>
      ) : null}
      <p className="line-clamp-4 text-sm whitespace-pre-wrap text-muted">
        {tool.definition.description}
      </p>
      {tool.removed ? (
        <p className="text-sm text-muted">
          The server no longer lists it, so it is not offered. It comes back if the server lists it
          again.
        </p>
      ) : null}
      {builtin ? (
        <p className="text-xs text-muted">Effect: {tool.effect}</p>
      ) : (
        <>
          <ToolControls slug={slug} tool={tool} />
          {readOnlyHint !== undefined ? (
            <p className="text-xs text-muted">
              The server hints it is {readOnlyHint ? "read-only" : "not read-only"}: a hint only,
              the effect is yours to choose.
            </p>
          ) : null}
        </>
      )}
      {tool.drifted && tool.listed ? (
        <div className="space-y-2 rounded-lg border border-brand/30 bg-brand/10 p-3">
          <p className="text-sm text-brand-text">
            The server now lists a different definition. The model keeps seeing the pinned one until
            you accept the new one.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Definition title="Pinned (what the model sees)" definition={tool.definition} />
            <Definition title="Listed now" definition={tool.listed} />
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default async function ToolServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ connected?: string }>;
}) {
  const access = await requireChatAccess();
  const { slug } = await params;
  const { connected } = await searchParams;
  const server = await consoleService().toolServer(access, slug);
  if (!server) notFound();
  const builtin = server.kind === "builtin";
  return (
    <Workspace>
      {server.status === "syncing" ? <RefreshWhileSyncing slug={server.slug} /> : null}
      <PageHeader
        title={server.slug}
        description={builtin ? "Kerby's own tools, served from code." : (server.url ?? "")}
        actions={<ServerStatus status={server.status} kind={server.kind} />}
      />
      <div className="space-y-6">
        {server.auth.kind === "oauth" ? (
          <Card
            title="Connection"
            actions={
              <ConnectButton
                action={connectToolServerAction.bind(null, server.slug)}
                connected={server.hasCredential}
              />
            }
          >
            <div className="space-y-3">
              {connected === "1" && server.hasCredential ? (
                <Alert tone="success">Connected. Its tools are being listed again.</Alert>
              ) : null}
              <p className="text-sm text-muted">
                {server.hasCredential
                  ? "Connected with OAuth for the whole workspace. Kerby keeps the tokens sealed, refreshes them, and never shows them."
                  : "Not connected: listing and calling its tools fail until you connect it. Connect sends you to the server's sign-in to approve Kerby, once for the whole workspace."}
              </p>
            </div>
          </Card>
        ) : null}
        <Card
          title="Status"
          actions={
            builtin ? null : <SyncButton action={syncToolServerAction.bind(null, server.slug)} />
          }
        >
          <DetailList
            items={[
              {
                term: "Status",
                value:
                  server.status === "syncing"
                    ? "A worker is listing its tools. This page refreshes when it is done."
                    : server.status === "ready"
                      ? "Ready"
                      : "The last listing failed",
              },
              ...(server.lastError
                ? [
                    {
                      term: "Last error",
                      value: <span className="text-danger">{server.lastError}</span>,
                    },
                  ]
                : []),
              {
                term: "Listed",
                value: server.syncedAt ? formatDateTime(server.syncedAt) : "Not yet",
              },
              { term: "Tools", value: toolCounts(server) },
            ]}
          />
        </Card>

        <Card title="Tools">
          {server.tools.length === 0 ? (
            <p className="text-sm text-muted">
              {server.status === "syncing" ? "None listed yet." : "The server lists no tools."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {server.tools.map((tool) => (
                <ToolItem key={tool.name} slug={server.slug} tool={tool} builtin={builtin} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Granted to">
          {server.grantedTo.length === 0 ? (
            <p className="text-sm text-muted">
              No integration is granted it. Integrations holding{" "}
              <code className="font-mono">admin</code> and this console may name every enabled tool;
              grant tools to any other on its page under{" "}
              <Link href="/dashboard/integrations" className="text-brand-text hover:underline">
                Integrations
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {server.grantedTo.map((grant) => (
                <li
                  key={`${grant.integrationId}:${grant.pattern}`}
                  className="flex gap-3 py-2 text-sm"
                >
                  <Link
                    href={`/dashboard/integrations/${grant.integrationId}`}
                    className="font-medium text-brand-text hover:underline"
                  >
                    {grant.integrationName}
                  </Link>
                  <code className="font-mono text-muted">{grant.pattern}</code>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {builtin ? null : (
          <>
            <Card title="Address and authentication">
              <EditServerForm
                action={updateToolServerAction.bind(null, server.slug)}
                url={server.url ?? ""}
                auth={server.auth}
                hasCredential={server.hasCredential}
              />
            </Card>
            {server.auth.kind === "header" ? (
              <Card title="Credential">
                <p className="mb-4 text-sm text-muted">
                  {server.hasCredential
                    ? `Sent in the ${server.auth.header} header. It is never shown.`
                    : "None stored: listing and calling its tools fail until you set one."}
                </p>
                <CredentialForm action={replaceToolCredentialAction.bind(null, server.slug)} />
              </Card>
            ) : null}
            <Card title="Danger zone">
              <p className="mb-4 text-sm text-muted">
                Deleting removes its tools, its credential, and every grant of it; conversations
                that named it stop being offered its tools.
              </p>
              <ConfirmAction
                action={deleteToolServerAction.bind(null, server.slug)}
                label="Delete server"
                question={`Delete ${server.slug} and its ${server.toolCount} tool(s)?`}
                confirmLabel="Delete"
              />
            </Card>
          </>
        )}
      </div>
    </Workspace>
  );
}
