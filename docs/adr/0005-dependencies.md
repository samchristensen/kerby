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
