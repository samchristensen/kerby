import type { ReactNode } from "react";
import { NavLink } from "../../_components/client.tsx";
import { Badge, ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireSession } from "../../_lib/session.ts";
import {
  ListPane,
  listItemActiveClass,
  listItemClass,
  SectionShell,
} from "../_components/panes.tsx";

export default async function IntegrationsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const integrations = await consoleService().integrations(session);
  const list = (
    <ListPane
      title="Integrations"
      actions={<ButtonLink href="/dashboard/integrations/new">New integration</ButtonLink>}
    >
      {integrations.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No integrations yet. Create one to hold API keys.
        </p>
      ) : (
        <ul>
          {integrations.map((integration) => (
            <li key={integration.id}>
              <NavLink
                href={`/dashboard/integrations/${integration.id}`}
                className={listItemClass}
                activeClassName={listItemActiveClass}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-fg">{integration.name}</span>
                  <Badge tone={integration.role === "admin" ? "brand" : "neutral"}>
                    {integration.role === "admin" ? "Admin" : "Restricted"}
                  </Badge>
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {integration.liveKeys === 1 ? "1 live key" : `${integration.liveKeys} live keys`}
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
