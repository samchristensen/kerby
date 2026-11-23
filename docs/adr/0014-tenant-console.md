# 0014. The tenant console: a Next.js service with self-serve sign-up

- Status: proposed
- Date: 2026-11-22

## Context

Plan 0001 M9 asks for a tenant console: a person signs up, signs in, makes API keys for their own code and brings their
model keys (ADR 0008), without an operator in the loop. Until now a tenant existed only after an operator called
control's operator API, and nothing knew about people: an API key was the only identity. The owner chose Next.js
(server components, server actions) and Tailwind CSS, and asked for a public URL on Railway.

Next.js does not fit the rules as written: it compiles (`next build`), it bundles the code it serves, it wants its
routes in `src/app`, and its checker needs TypeScript's JavaScript API, which TypeScript 7 does not have.

## Decision

- **A fourth service, `services/console` (`@kerby/console`).** Public, like the api. It owns no tables: people and
  sessions live in the control database (migration `packages/control-plane/migrations/control/0005_console.sql`), read and
  written through `@kerby/control-plane`.
- **Next.js behind a server the console owns.** `src/index.ts` is the composition root as in every service: it loads
  the config once (and fails loudly), builds the control database handle, the sealer and the sign-up client natively,
  installs the service object (`installConsole`, `src/app/_lib/console.ts`), then starts `node:http` with Next.js's
  request handler (`src/runtime/server.ts`), which answers `/healthz` itself and stamps each request with the client's
  address. `next start` is not used: it would have no composition root.
- **`src/app` is the runtime layer, and imports Kerby code as types only.** Next.js bundles `src/app`; Kerby packages
  loaded inside the bundle would be second copies, apart from the ones `src/index.ts` built (and some do not survive
  bundling: `import.meta.dirname` is undefined there). So pages and server actions reach Kerby only through
  `consoleService()`, and `import type` everything else. `make architecture` (rule `layers`) accepts `src/app` in a service
  that declares `next`, counts it as `runtime`, and refuses a value import of `@kerby/*` or of anything outside `src/app`
  from it.
- **The one build step.** `next build` compiles `src/app` when the image is built (Dockerfile stage `build`); everything
  else still runs as TypeScript. Next.js's own type check is off (`typescript.ignoreBuildErrors`): `make typecheck` runs
  `tsc` on the repository and `tsc -p services/console` on the pages (JSX, the DOM).
- **Self-serve sign-up goes through control.** Only control can make a tenant database. The console calls
  `POST /v1/console/signups` on control's private address with `CONSOLE_TOKEN`, a token that opens that route and nothing
  else; the operator token does not open it. Control provisions as it does for an operator (audited as `console`), then
  stores the person. The console hashes the password first, so control never sees one. An email has one account;
  a taken name or email is 409 `name_taken` or `email_taken`; a person who loses a race for an email leaves no tenant.
- **People and sessions.** A person belongs to one tenant (`console_users`: email, scrypt hash with OWASP's parameters
  stored in the hash). A session is a random 256-bit token in an HttpOnly, SameSite=Lax, Secure cookie; the table keeps
  its SHA-256 and an expiry (7 days). A suspended or deleted tenant's sessions stop at once and its people cannot sign
  in; deleting a tenant deletes its people and sessions.
- **A tenant id comes from a verified session.** Every console operation takes the `Session` that `session(token)`
  returned; a key id or provider in a URL is always scoped by that tenant in SQL. Changes are audited as `user:<id>`.
- **Its own database role.** The console connects as `kerby_console` (migration 0005): tenants (read), API keys
  (create, list, revoke; never the hash), `tenant_secrets` (as the api), audit (append), people (read), sessions. Control
  sets its password (`CONSOLE_DATABASE_PASSWORD`) at startup, as for `kerby_app`.
- **Model keys as the api stores them**: sealed to `SECRETS_PUBLIC_KEY` (ADR 0008), providers from the adapter's id list
  (`@kerby/runtime-pi-durable/providers`, imported by `src/index.ts`).
- **Before sign-in, bounded work**: sign-ups per address per hour (each makes a database; default 5), failed sign-ins
  per address per minute (10) and per account per hour (20). Per process, like the api's limits (`TokenBuckets`, now in
  `@kerby/serve`). An unknown email costs a hash too, so timing does not say which emails exist.
- **Hosting.** A Railway service `console` with a generated domain, from the image CI builds (ADR 0011). Control listens on
  `::` so the console reaches it over the private network. `scripts/railway.ts secrets` creates `CONSOLE_TOKEN` and
  `CONSOLE_DATABASE_PASSWORD` once; `domains` adds the public domains; the release runs both.
- Rejected: a single-page app over the api (people and sessions would move into the internet-facing api, and the
  owner asked for server components); `next start` with Kerby packages bundled (no composition root, a second copy of
  every package, packages constrained to what a bundler accepts); giving the console the operator token or the cluster
  admin URL (an internet-facing process able to delete any tenant); provisioning from a queue control polls (more
  moving parts for the same result).

## Consequences

- Sign-up is open to anyone who reaches the console. The per-address limit bounds one address, not a botnet: there is no
  CAPTCHA, email verification, password reset or invitation of a second person yet (tech debt).
- The console can create keys for any tenant and set its model keys if its process is taken over, as the api can read
  any tenant's data: both are trusted processes facing the internet. It cannot open a model key, provision, delete or
  export.
- Next.js and React are in the catalog; their versions move with the rest (`minimumReleaseAge`).
- The console's image is larger than the others (Next.js and the compiled pages) and takes a build step in CI.
