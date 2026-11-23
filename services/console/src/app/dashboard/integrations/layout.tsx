import type { ReactNode } from "react";
import { NavLink } from "../../_components/client.tsx";
import { Badge, ButtonLink } from "../../_components/ui.tsx";
import { consoleService } from "../../_lib/console.ts";
import { requireChatAccess } from "../../_lib/session.ts";
import {
  ListPane,
  listItemActiveClass,
  listItemClass,
  SectionShell,
} from "../_components/panes.tsx";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export default async function IntegrationsLayout({ children }: { children: ReactNode }) {
  const access = await requireChatAccess();
  const integrations = await consoleService().integrations(access);
  const list = (
    <ListPane
      title="Integrations"
      actions={<ButtonLink href="/dashboard/integrations/new">New integration</ButtonLink>}
    >
      {integrations.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">
          No integrations. Create one to get an API key.
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
                <span className="block truncate text-sm font-medium text-fg">
                  {integration.name}
                </span>
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {integration.scopes.map((scope) => (
                    <Badge key={scope} tone={scope === "admin" ? "danger" : "brand"}>
                      {scope}
                    </Badge>
                  ))}
                </span>
                <span className="mt-1.5 block text-xs text-muted">
                  {plural(integration.activeKeys, "key")} ·{" "}
                  {plural(integration.subscriptions, "subscription")}
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
