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
