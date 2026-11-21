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
