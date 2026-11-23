import type { ReactNode } from "react";
import { quickstart } from "./_components/format.ts";
import { ButtonLink, CodeBlock, Logo, Mascot } from "./_components/ui.tsx";
import { getSession } from "./_lib/session.ts";

const features: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Turns survive crashes",
    body: "Every message is persisted before anything acts on it. If a worker dies mid-turn, any other worker resumes the turn where it stopped.",
    icon: <path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4" />,
  },
  {
    title: "Bring your own model keys",
    body: "Use your own keys for 11 providers. Each key is sealed to a key the API cannot open; only the run that uses it can.",
    icon: <path d="M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7Zm1 2.5h.01" />,
  },
  {
    title: "Isolation per tenant",
    body: "Every workspace gets its own Postgres database and its own storage prefix. Nothing is shared between tenants' data.",
    icon: (
      <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    ),
  },
  {
    title: "Streaming with replay",
    body: "Follow a turn live over server-sent events. Reconnect at any point and replay everything you missed.",
    icon: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  },
];

export default async function LandingPage() {
  const session = await getSession();
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Logo href="/" />
          <nav className="flex items-center gap-2">
            {session ? (
              <ButtonLink href="/dashboard">Open dashboard</ButtonLink>
            ) : (
              <>
                <ButtonLink href="/login" variant="ghost">
                  Sign in
                </ButtonLink>
                <ButtonLink href="/signup">Get started</ButtonLink>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="bg-gradient-to-b from-brand/10 to-page">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
            <div>
              <div className="mb-6">
                <Mascot state="friendly" size={180} large />
              </div>
              <p className="text-sm font-semibold text-brand-text">Agent runtime as a service</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-fg sm:text-5xl">
                Durable agents on your own model keys
              </h1>
              <p className="mt-5 text-lg text-muted">
                Kerby runs your agents' conversations so they survive crashes, stream live, and stay
                isolated per tenant. You bring the model keys; we keep every turn safe.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="/signup">Create a workspace</ButtonLink>
                <ButtonLink href="/login" variant="secondary">
                  Sign in
                </ButtonLink>
              </div>
            </div>
            <div className="min-w-0 rounded-xl border border-line bg-ink shadow-xl">
              <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
                <span className="size-2.5 rounded-full bg-line" />
                <span className="size-2.5 rounded-full bg-line" />
                <span className="size-2.5 rounded-full bg-line" />
                <span className="ml-2 text-xs text-muted">quickstart.sh</span>
              </div>
              <CodeBlock>{quickstart("https://<api>")}</CodeBlock>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pt-8 pb-20">
          <h2 className="text-2xl font-semibold tracking-tight text-fg">
            Built for agents that must not lose work
          </h2>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-line bg-panel p-6 shadow-sm"
              >
                <div className="inline-flex rounded-lg bg-brand/10 p-2 text-brand-text">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-5"
                  >
                    {feature.icon}
                  </svg>
                </div>
                <h3 className="mt-4 font-semibold text-fg">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-muted">
          <Logo />
          <p>© {new Date().getFullYear()} Kerby. Durable agents, your keys.</p>
        </div>
      </footer>
    </div>
  );
}
