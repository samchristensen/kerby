import type { ReactNode } from "react";
import { NavLink, SubmitButton } from "../_components/client.tsx";
import { Logo } from "../_components/ui.tsx";
import { requireSession } from "../_lib/session.ts";
import { logOutAction } from "./actions.ts";

const nav = [
  {
    href: "/dashboard",
    label: "Overview",
    exact: true,
    icon: "M3 10.5 10 4l7 6.5V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1v-6.5Z",
  },
  {
    href: "/dashboard/chats",
    label: "Chats",
    exact: false,
    icon: "M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h-1A1.5 1.5 0 0 1 3 12.5v-8Z",
  },
  {
    href: "/dashboard/studio",
    label: "Studio",
    exact: false,
    icon: "M4 3.5h8l4 4V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm8 0v4h4M6.5 11h7M6.5 14h4.5",
  },
  {
    href: "/dashboard/api-keys",
    label: "API keys",
    exact: false,
    icon: "M12.5 3a4.5 4.5 0 1 1-4.3 5.8L3 14v3h3v-2h2v-2h1.2l.6-.6A4.5 4.5 0 0 1 12.5 3Zm1 3.5h.01",
  },
  {
    href: "/dashboard/providers",
    label: "Model providers",
    exact: false,
    icon: "M10 2.5 17 6.5v7L10 17.5 3 13.5v-7L10 2.5Zm0 0v15M3 6.5l7 4 7-4",
  },
];

/** Only an admin sees this (the page itself refuses everyone else). */
const adminNav = {
  href: "/dashboard/admin",
  label: "Sign-ups",
  exact: false,
  icon: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6 7a6 6 0 0 1 12 0M15.5 5v4M13.5 7h4",
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      className="size-4.5 shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

function SignOut({ compact }: { compact: boolean }) {
  return (
    <form action={logOutAction}>
      <SubmitButton variant="ghost" pending="Signing out…" full={!compact}>
        Sign out
      </SubmitButton>
    </form>
  );
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const items = session.isAdmin ? [...nav, adminNav] : nav;
  return (
    <div className="flex h-screen flex-col bg-page lg:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel lg:flex">
        <div className="px-5 pt-5">
          <Logo href="/dashboard" />
        </div>
        <div className="mx-3 mt-5 rounded-lg border border-line bg-page px-3 py-2.5">
          <p className="truncate text-sm font-semibold text-fg">{session.tenantName}</p>
          <p className="truncate text-xs text-muted">{session.email}</p>
        </div>
        <nav aria-label="Dashboard" className="mt-5 flex flex-1 flex-col gap-0.5 px-3">
          {items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              exact={item.exact}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-fg"
              activeClassName="bg-brand/10 text-brand-text hover:bg-brand/10 hover:text-brand-text/80"
            >
              <NavIcon d={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <SignOut compact={false} />
        </div>
      </aside>

      <header className="shrink-0 border-b border-line bg-panel lg:hidden">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <Logo href="/dashboard" />
          <div className="flex min-w-0 items-center gap-3">
            <p className="truncate text-sm font-medium text-fg">{session.tenantName}</p>
            <SignOut compact />
          </div>
        </div>
        <nav aria-label="Dashboard" className="flex gap-1 overflow-x-auto px-3 pb-2">
          {items.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              exact={item.exact}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted hover:bg-raised"
              activeClassName="bg-brand/10 text-brand-text"
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
