"use client";
// Interactive pieces: they need the browser (clipboard, form status, local state, the current path).
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useFormStatus } from "react-dom";
import { type ButtonVariant, buttonStyles } from "./ui.tsx";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
        {copied ? (
          <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" />
        ) : (
          <path d="M7 3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7Zm-4 4a1 1 0 0 0-1 1v8a2 2 0 0 0 2 2h6a1 1 0 1 0 0-2H4V8a1 1 0 0 0-1-1Z" />
        )}
      </svg>
      {copied ? "Copied" : label}
    </button>
  );
}

/** A value shown once (an API key, a signing secret): monospace, copyable, with a warning that names it (`noun`). */
export function SecretReveal({ secret, noun = "key" }: { secret: string; noun?: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2 pl-3">
        <code className="min-w-0 flex-1 break-all font-mono text-sm text-zinc-900">{secret}</code>
        <CopyButton value={secret} />
      </div>
      <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="mt-0.5 size-4 shrink-0"
        >
          <path d="M8.3 2.9a2 2 0 0 1 3.4 0l6.3 11a2 2 0 0 1-1.7 3H3.7A2 2 0 0 1 2 14l6.3-11ZM10 7a1 1 0 0 0-1 1v3a1 1 0 1 0 2 0V8a1 1 0 0 0-1-1Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
        </svg>
        This {noun} is shown only once. Copy it now and store it somewhere safe; Kerby cannot show
        it again.
      </p>
    </div>
  );
}

export function SubmitButton({
  children,
  pending: pendingLabel,
  variant = "primary",
  full = false,
}: {
  children: ReactNode;
  pending: string;
  variant?: ButtonVariant;
  full?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${buttonStyles[variant]} ${full ? "w-full" : ""}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

/** A destructive action behind a second click. `action` is a bound server action. */
export function ConfirmAction({
  action,
  label,
  question,
  confirmLabel,
}: {
  action: () => Promise<void>;
  label: string;
  question: string;
  confirmLabel: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={buttonStyles.secondary} onClick={() => setAsking(true)}>
        <span className="text-red-600">{label}</span>
      </button>
    );
  }
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3"
    >
      <p className="flex-1 text-sm text-red-800">{question}</p>
      <button type="button" className={buttonStyles.secondary} onClick={() => setAsking(false)}>
        Cancel
      </button>
      <SubmitButton variant="danger" pending="Working…">
        {confirmLabel}
      </SubmitButton>
    </form>
  );
}

/** A link styled by whether it points at the current page (`exact`) or one of its children. */
export function NavLink({
  href,
  exact = false,
  className,
  activeClassName,
  children,
}: {
  href: string;
  exact?: boolean;
  className: string;
  activeClassName: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${className} ${active ? activeClassName : ""}`}
    >
      {children}
    </Link>
  );
}
