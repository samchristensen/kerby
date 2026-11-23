// Small presentational pieces shared by every page. Server-safe: no hooks here.
import Link from "next/link";
import type { ReactNode } from "react";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

export const buttonStyles = {
  primary: `${buttonBase} bg-brand text-on-brand shadow-sm hover:bg-brand/85`,
  secondary: `${buttonBase} border border-line bg-panel text-fg shadow-sm hover:bg-raised`,
  danger: `${buttonBase} bg-danger text-on-danger shadow-sm hover:bg-danger/85`,
  ghost: `${buttonBase} text-muted hover:bg-raised hover:text-fg`,
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
    <span className="inline-flex items-center gap-2 text-fg">
      <svg aria-hidden="true" viewBox="120 52 272 348" className="h-8 w-auto">
        <line
          x1="256"
          y1="136"
          x2="256"
          y2="96"
          stroke="#0A0B10"
          strokeWidth="22"
          strokeLinecap="round"
        />
        <line
          x1="256"
          y1="136"
          x2="256"
          y2="96"
          stroke="#F2B33D"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <circle cx="256" cy="84" r="22" fill="#39FF7F" stroke="#0A0B10" strokeWidth="9" />
        <path
          d="M256 132 C330 132 372 180 378 250 C384 320 380 372 330 384 L182 384 C132 372 128 320 134 250 C140 180 182 132 256 132 Z"
          fill="#F2B33D"
          stroke="#0A0B10"
          strokeWidth="16"
        />
        <rect x="166" y="198" width="180" height="108" rx="54" fill="#0A0B10" />
        <ellipse cx="212" cy="254" rx="24" ry="31" fill="#39FF7F" />
        <ellipse cx="300" cy="254" rx="24" ry="31" fill="#39FF7F" />
        <polygon points="182,212 242,212 242,238 182,224" fill="#0A0B10" />
        <polygon points="270,212 330,212 330,224 270,238" fill="#0A0B10" />
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

/** The animated mascot (a custom element from public/operator-mascot.js). Intro and orbit are for large placements. */
export function Mascot({
  state = "focused",
  size,
  large = false,
}: {
  state?: "focused" | "friendly" | "thinking" | "walking";
  size: number;
  large?: boolean;
}) {
  return (
    <operator-mascot
      state={state}
      size={size}
      no-intro={large ? undefined : ""}
      no-orbit={large ? undefined : ""}
      // Reserve the space before the script upgrades the element, so the page does not jump.
      style={{ display: "inline-block", width: size, aspectRatio: "512 / 420" }}
    />
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
    <section className="rounded-xl border border-line bg-panel shadow-sm">
      {title ? (
        <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

const badgeTones = {
  live: "bg-live/10 text-live-text ring-live/30",
  neutral: "bg-raised text-muted ring-line",
  danger: "bg-danger/10 text-danger ring-danger/30",
  brand: "bg-brand/10 text-brand-text ring-brand/30",
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
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** A centered explanation for an empty pane. */
export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <div className="mb-4">
        <Mascot state="friendly" size={96} />
      </div>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      <div className="mt-2 space-y-3 text-sm text-muted">{children}</div>
    </div>
  );
}

/** Label/value rows for a detail view. */
export function DetailList({ items }: { items: { term: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-line">
      {items.map((item) => (
        <div key={item.term} className="grid grid-cols-3 gap-4 py-3 text-sm first:pt-0 last:pb-0">
          <dt className="text-muted">{item.term}</dt>
          <dd className="col-span-2 text-fg">{item.value}</dd>
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
    error: "border-danger/30 bg-danger/10 text-danger",
    warning: "border-brand/30 bg-brand/10 text-brand-text",
    success: "border-live/30 bg-live/10 text-live-text",
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
    <pre className="overflow-x-auto rounded-lg bg-ink p-4 font-mono text-[13px] leading-relaxed text-fg">
      <code>{children}</code>
    </pre>
  );
}
