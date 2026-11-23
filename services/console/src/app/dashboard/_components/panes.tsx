// The three-pane layout of a section: a list pane beside the primary workspace.
import type { ReactNode } from "react";

export function ListPane({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex max-h-72 w-full shrink-0 flex-col border-b border-line bg-panel md:max-h-none md:w-80 md:border-r md:border-b-0"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function SectionShell({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {list}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

/** The primary workspace's padded column. */
export function Workspace({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-8">{children}</div>;
}

export const listItemClass = "block border-b border-line px-4 py-3 hover:bg-raised";
export const listItemActiveClass =
  "bg-brand/10 hover:bg-brand/10 shadow-[inset_3px_0_0_var(--color-primary)]";
