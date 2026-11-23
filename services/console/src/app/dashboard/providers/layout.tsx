import type { ReactNode } from "react";
import { NavLink } from "../../_components/client.tsx";
import { consoleService } from "../../_lib/console.ts";
import { providerName } from "../../_lib/providers.ts";
import { requireSession } from "../../_lib/session.ts";
import {
  ListPane,
  listItemActiveClass,
  listItemClass,
  SectionShell,
} from "../_components/panes.tsx";

export default async function ProvidersLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const providers = await consoleService().providers(session);
  const list = (
    <ListPane title="Model providers">
      <ul>
        {providers.map((provider) => (
          <li key={provider.id}>
            <NavLink
              href={`/dashboard/providers/${provider.id}`}
              className={listItemClass}
              activeClassName={listItemActiveClass}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-zinc-900">
                  {providerName(provider.id)}
                </span>
                <span
                  className={`flex shrink-0 items-center gap-1.5 text-xs ${provider.configured ? "text-emerald-700" : "text-zinc-400"}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-2 rounded-full ${provider.configured ? "bg-emerald-500" : "bg-zinc-300"}`}
                  />
                  {provider.configured ? "Key set" : "No key"}
                </span>
              </span>
              <code className="mt-0.5 block font-mono text-xs text-zinc-500">{provider.id}</code>
            </NavLink>
          </li>
        ))}
      </ul>
    </ListPane>
  );
  return <SectionShell list={list}>{children}</SectionShell>;
}
