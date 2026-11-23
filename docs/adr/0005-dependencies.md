# 0005. Third-party dependencies

- Status: accepted
- Date: 2026-11-21

## Context

ARCHITECTURE.md#dependencies asks for an ADR line (what, why, alternatives) per new dependency. One running list
keeps them findable. Exact pins live in the catalog of `pnpm-workspace.yaml`; this file holds the reasons.

## Decision

One line per dependency: name, owner workspace, why, alternatives rejected.

- `zod` (`packages/config`, `packages/contracts`, services): runtime validation that doubles as the TypeScript type. Rejected: hand-written parsers (drift), valibot/ajv (a second schema language to learn for no gain).
- `yaml` (`packages/config`, `scripts`): the YAML layer of configuration and the workspace catalog reader. Rejected: JSON-only config (operators expect YAML in Compose and Kubernetes).
- `pg` + `@types/pg` (`packages/db`): the Postgres driver Absurd also requires as a peer. Rejected: postgres.js, drizzle/kysely (Absurd needs a `pg.Pool`; SQL stays plain).
- `absurd-sdk` (`packages/durable`): durable tasks, steps, retries as a SQL schema in each tenant database (ADR 0002). Rejected: Temporal, pg-boss (ADR 0002).
- `@aws-sdk/client-s3` (`packages/blobs`): S3 API for RustFS locally and any S3 in production, path-style addressing. Rejected: minio-js (vendor-specific), hand-signed fetch (SigV4 and multipart are not ours to maintain).
- `@aws-sdk/s3-request-presigner` (`packages/blobs`, pinned with `client-s3` at the same version): presigned GET URLs for tenant exports (ADR 0013), checked against RustFS (download works, refused after expiry). Rejected: hand-signing SigV4 query strings (the same reason as for the client).
- `@earendil-works/pi-durable`, `pi-ai`, `chord` (`packages/runtime-pi-durable`, pinned together at 1.4.0, the spike's version; Pi publishes them in lockstep): the first agent harness (ADR 0003). Rejected: writing our own tool loop (provider quirks, retries, streaming, caching are the harness's job).
- `railway` (root dev dependency, `.railway/railway.ts`): the typed DSL (`railway/iac`) the Railway CLI evaluates for Infrastructure as Code (ADR 0007). Rejected: Terraform (a third-party provider and a state backend), `railway.json` (Config as Code, deprecated by Railway).
- `knip` (root dev dependency, `make knip` in `make check`): dead files, unused exports and types across workspaces, unused or undeclared dependencies. It parses with oxc, so it runs beside TypeScript 7, which has no JavaScript API. Rejected: ts-prune and ts-unused-exports (need the TypeScript compiler API; exports only, no dependencies), tsc `noUnusedLocals` (one file at a time, blind to exports).
- `next`, `react`, `react-dom` (`services/console`): the tenant console's pages, rendered on the server with server actions for forms (ADR 0014); the owner's choice. Run behind the console's own `node:http` server, never `next start`. Rejected: a single-page app over the api (people and sessions would move into the internet-facing api), Remix/React Router (no reason to pick a second React framework over the owner's choice).
- `tailwindcss`, `@tailwindcss/postcss` (`services/console`, dev): the console's styles, compiled by `next build` through PostCSS; the owner's choice. Rejected: CSS modules or hand-written CSS (more code for the same pages).
- `@types/react`, `@types/react-dom` (`services/console`, dev): types for `tsc -p services/console`.
- `@milkdown/crepe`, `@milkdown/kit` (`services/console`, pinned together at 7.23.0; Milkdown publishes them in lockstep): the Studio's WYSIWYG markdown editor (ADR 0017), remark-based, with a slash menu, a selection toolbar, tables and CodeMirror code blocks; loaded client-side only, about 410 KB gzip on the pages that use it (it bundles Vue for its menus). The plan 0004 spike measured a 26-case prompt corpus in Chromium: 22 byte-identical, 4 normalized but equivalent, none lossy (LaTeX and images left out, since remark-math escapes every `$`). Rejected: Tiptap 3.34 with `@tiptap/markdown` (escaped every `<tag>` to `&lt;tag&gt;`, wrote `{{ customer\_name }}`, dropped the HTML comment, flattened a nested list; 11/26 identical), MDXEditor 4.5 (parses MDX: fails on `<instructions>`-style tags and autolinks, drops comments; 10/26 identical).
