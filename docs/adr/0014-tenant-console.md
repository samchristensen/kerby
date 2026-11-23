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

## Amendment: chat and browsing in the console (2026-11-22)

A signed-in person can talk to the agent in the browser and open every conversation of the tenant, however it began (API
call or console). The data is the tenant's, behind the api; the console never opens a tenant database.

- **The api accepts a console session as a credential.** A bearer token that is not a `kb_` key is looked up as a session
  (`authenticateConsoleSession`, migration `0006_app_reads_sessions.sql`: `kerby_app` may read `console_sessions`, never
  `console_users`). The tenant is the session's, the audit actor is `user:<id>`, and the 3 s to 30 s auth cache, the
  per-tenant request limit, the storage quota, the busy check and the stream caps apply unchanged. Sign-out, a lapsed
  session and a suspended tenant end it within the cache window, as for a revoked key.
- **The console forwards the person's session token to the api over the private network** (`API_URL`; the api listens on
  `::` hosted), from server components, server actions and one route handler that relays the event stream
  (`/dashboard/chats/<id>/events`). The browser holds only the HttpOnly cookie; the token is never a prop, a response body
  or a log field. `ChatAccess` (session plus token) is the one type that carries it, server-side only.
- **Browsing is a new api route**, `GET /v1/conversations?limit&cursor&externalUserId`: most recently active first (a
  conversation's `updated_at` moves with each message, migration `conversations/0003_browsing.sql`), keyset-paged, each with
  a `title` (the opening of its first user message, set once) and `messageCount`. It is part of the public API, so a
  tenant's own code can list its conversations too. A conversation the console starts carries the end-user name
  `console:<userId>`; anything else is shown as API.
- Rejected: giving the console a tenant-database pool and the blob store (a second copy of posting, quota and streaming
  logic, and the console would need `TENANT_DB_KEYS`); the console naming a tenant to the api with a shared token (the api
  would trust a caller's claim, where a session is something it verifies); the browser calling the api directly (CORS
  and a credential in page script).
- Consequences: a compromised console can already mint a key for any tenant, so forwarding sessions widens nothing it
  could not do; a compromised api can read session hashes, which no one can invert. Messages render as plain text (no
  markdown: a renderer is a dependency and an ADR line). There is no way to delete or rename a conversation.

## Amendment: sign-up by invitation, and an admin (2026-11-23)

- **Control refuses a sign-up whose email is not on `signup_allowlist`** (migration `0007_signup_allowlist.sql`): 403
  `not_invited`, before it provisions anything and before it says whether the address has an account. The check lives in
  control, not the console, because control is the only door to provisioning. The migration puts every existing account's
  email on the list. Removing an address stops a future sign-up; it does not touch an account that exists.
- **An admin is a `console_users` row with `is_admin`.** The operator sets it, over control's operator API
  (`POST /v1/operator/console-admins`, audited, 404 for an email with no account: docs/deploy.md#the-console). The
  console's role reads the flag and has no grant to write it, so a console bug or a forged form cannot make an admin. It
  is not a role in a tenant: the admin's own tenant is an ordinary one, and the flag only opens the Sign-ups page.
- **Admins edit the list in the console** (`/dashboard/admin`, shown in the navigation to admins only; anyone else gets a
  404). The service checks the flag again on each call. Changes are audited as `user:<id>` with a count, never an address.
- Rejected: an `ADMIN_EMAILS` variable (an address would be an admin by naming it, before it proves it owns the address;
  and a redeploy per change); an allowlist in a variable (the point is to edit it from the console).
- Consequences: an admin account is the keys to who may join, so its password matters; there is still no second factor
  (tech debt).

## Amendment: integrations and tools (2026-11-23)

ADR 0019. The API keys pages became Integrations (`/dashboard/integrations`): a person names an integration, gives it a
role (`admin`, or `restricted` to conversations and judgments with only the tools granted to it), makes and revokes its
keys, renames or archives it (archiving revokes its keys). The console writes `integrations` and the keys' `integration_id`
directly, as it did keys (`kerby_console` gained `select`, `insert` and `update (name, role, updated_at, archived_at)` on
`integrations` and `integration_id` on `api_keys`). Tools live in the tenant's database, so the console reaches them through
the api with the person's session token, like the Studio: `/dashboard/tools` (servers, their status and listing, the
credential, enabling, effect, drift review, the integrations granted), a restricted integration's tool grants, and a tool
picker on a new chat and in a chat prompt's draft. A credential is never shown back.

## Consequences

- Sign-up is by invitation (amendment above), not open. The per-address limit still bounds one address; there is no CAPTCHA,
  email verification, password reset or invitation of a second person yet (tech debt). Verification matters more now:
  an allowlisted address is trusted without proof that the person who types it owns it.
- The console can create keys for any tenant and set its model keys if its process is taken over, as the api can read
  any tenant's data: both are trusted processes facing the internet. It cannot open a model key, provision, delete or
  export.
- Next.js and React are in the catalog; their versions move with the rest (`minimumReleaseAge`).
- The console's image is larger than the others (Next.js and the compiled pages) and takes a build step in CI.
