import type { ReactNode } from "react";
import { NavLink } from "../../_components/client.tsx";
import { formatDate } from "../../_components/format.ts";
import { Badge, ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireSession } from "../../_lib/session.ts";
import {
  ListPane,
  listItemActiveClass,
  listItemClass,
  SectionShell,
} from "../_components/panes.tsx";

export default async function ApiKeysLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const keys = await consoleService().apiKeys(session);
  const list = (
    <ListPane
      title="API keys"
      actions={<ButtonLink href="/dashboard/api-keys/new">New key</ButtonLink>}
    >
      {keys.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-zinc-500">
          No API keys yet. Create one to call the API.
        </p>
      ) : (
        <ul>
          {keys.map((key) => (
            <li key={key.id}>
              <NavLink
                href={`/dashboard/api-keys/${key.id}`}
                className={listItemClass}
                activeClassName={listItemActiveClass}
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm font-medium ${key.label ? "text-zinc-900" : "text-zinc-500 italic"}`}
                  >
                    {key.label || "Untitled key"}
                  </span>
                  {key.revokedAt ? (
                    <Badge tone="zinc">Revoked</Badge>
                  ) : (
                    <Badge tone="green">Active</Badge>
                  )}
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
                  <code className="truncate font-mono">kb_{key.id}_…</code>
                  <span className="shrink-0">{formatDate(key.createdAt)}</span>
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </ListPane>
  );
  return <SectionShell list={list}>{children}</SectionShell>;
}
