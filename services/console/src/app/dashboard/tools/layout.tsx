import type { ReactNode } from "react";
import { NavLink } from "../../_components/client.tsx";
import { ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";
import {
  ListPane,
  listItemActiveClass,
  listItemClass,
  SectionShell,
} from "../_components/panes.tsx";
import { ServerStatus, toolCounts } from "./status.tsx";

export default async function ToolsLayout({ children }: { children: ReactNode }) {
  const access = await requireChatAccess();
  const servers = await consoleService().toolServers(access);
  const list = (
    <ListPane
      title="Tool servers"
      actions={<ButtonLink href="/dashboard/tools">Add a server</ButtonLink>}
    >
      <ul>
        {servers.map((server) => (
          <li key={server.slug}>
            <NavLink
              href={`/dashboard/tools/${server.slug}`}
              className={listItemClass}
              activeClassName={listItemActiveClass}
            >
              <span className="flex items-center justify-between gap-2">
                <code className="truncate font-mono text-sm font-medium text-zinc-900">
                  {server.slug}
                </code>
                <ServerStatus status={server.status} kind={server.kind} />
              </span>
              <span className="mt-1 block truncate text-xs text-zinc-500">
                {server.kind === "builtin"
                  ? "Kerby's own tools"
                  : `${server.url ?? ""} · ${
                      server.auth.kind === "header"
                        ? `${server.auth.header} header`
                        : server.auth.kind === "oauth"
                          ? server.hasCredential
                            ? "OAuth, connected"
                            : "OAuth, not connected"
                          : "no auth"
                    }`}
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">{toolCounts(server)}</span>
              {server.status === "error" && server.lastError ? (
                <span className="mt-0.5 block truncate text-xs text-red-600">
                  {server.lastError}
                </span>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </ListPane>
  );
  return <SectionShell list={list}>{children}</SectionShell>;
}
