// Small presentational pieces shared by every page. Server-safe: no hooks here.
import Link from "next/link";
import type { ReactNode } from "react";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const buttonStyles = {
  primary: `${buttonBase} bg-indigo-600 text-white shadow-sm hover:bg-indigo-500`,
  secondary: `${buttonBase} border border-zinc-300 bg-white text-zinc-800 shadow-sm hover:bg-zinc-50`,
  danger: `${buttonBase} bg-red-600 text-white shadow-sm hover:bg-red-500`,
  ghost: `${buttonBase} text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900`,
} as const;

export type ButtonVariant = keyof typeof buttonStyles;

export function ButtonLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonStyles[variant]}>
      {children}
    </Link>
  );
}

export function Logo({ href }: { href?: string }) {
  const mark = (
    <span className="inline-flex items-center gap-2 text-zinc-900">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7">
        <rect width="24" height="24" rx="6" className="fill-indigo-600" />
        <path
          d="M8 6v12M8 12l7-6M10.5 10l5 8"
          stroke="white"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-lg font-semibold tracking-tight">Kerby</span>
    </span>
  );
  return href ? (
    <Link href={href} className="rounded-md">
      {mark}
    </Link>
  ) : (
    mark
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
      {title ? (
        <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

const badgeTones = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  zinc: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
} as const;

export function Badge({ tone, children }: { tone: keyof typeof badgeTones; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeTones[tone]}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-zinc-500">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** A centered explanation for an empty pane. */
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      {icon ? <div className="mb-4 rounded-xl bg-indigo-50 p-3 text-indigo-600">{icon}</div> : null}
      <h2 className="text-base font-semibold text-zinc-900">{title}</h2>
      <div className="mt-2 space-y-3 text-sm text-zinc-500">{children}</div>
    </div>
  );
}

/** Label/value rows for a detail view. */
export function DetailList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-zinc-100">
      {items.map((item) => (
        <div key={item.term} className="grid grid-cols-3 gap-4 py-3 text-sm first:pt-0 last:pb-0">
          <dt className="text-zinc-500">{item.term}</dt>
          <dd className="col-span-2 text-zinc-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: "error" | "warning" | "success";
  children: ReactNode;
}) {
  const styles = {
    error: "border-red-200 bg-red-50 text-red-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-lg border px-3.5 py-2.5 text-sm ${styles[tone]}`}
    >
      {children}
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-4 font-mono text-[13px] leading-relaxed text-zinc-100">
      <code>{children}</code>
    </pre>
  );
}
