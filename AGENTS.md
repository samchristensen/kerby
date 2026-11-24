# AGENTS.md

Kerby: a self-hosted agent runtime, one install (one tenant) per project, in Docker Compose or the project's Railway
project; the multi-tenant boundary stays for a later SaaS, so a tenant is still untrusted (ADR 0024). Humans steer;
agents execute; a human merges. Stack: TypeScript on Node (no build step but the console's Next.js pages), pnpm
workspaces. Postgres is the only service: a control database plus one database per tenant, with durable execution
through Absurd. Bytes and transcripts live in S3-compatible storage, indexed in the tenant's database. Agent harnesses
(Pi Durable first) sit behind `AgentRuntime`.

## Where to look

| Read                                     | When                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/plans/active/](docs/plans/active)  | First, on every task and after any context reset: the plan that owns it. `0002-autonomous-build.md` is the runbook for unattended work. Log progress there. |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | Before adding or moving a file, package, service, or dependency: layers, providers, tenancy, turn lifecycle.                                                |
| [docs/principles.md](docs/principles.md) | Before writing code.                                                                                                                                        |
| [docs/adr/](docs/adr)                    | Before deciding structure, dependencies, infrastructure, or tenancy; record the decision after.                                                             |
| [docs/README.md](docs/README.md)         | Anything else: the index.                                                                                                                                   |

## Loop

1. Take the next unchecked item of the active plan. Use a git worktree for parallel work.
2. Change code and the docs it touches in the same commit: stale docs are bugs.
3. `make check`, then `make test`. Red means fix the code.
4. Run the changed path for real and observe it; tests alone are not proof.
5. Tick the plan item and add one line to its log.

Done = `make check` and `make test` green and the changed path observed.

## When something fails

Name the missing capability (a check, a test, a doc line, a tool) and add it, then fix the code. A check's failure
message says how to fix the violation; follow it. A rule that needs changing needs an ADR.

## Invariants

- Imports point one way: scripts and services to packages, services never to services; inside a service, `types -> config -> repo -> service -> runtime`. Enforced.
- Each external system (Postgres, Absurd, S3, a harness) sits behind one package. Enforced.
- A tenant is a database: repo functions take a `ControlDb` or `TenantDb`, never a pool; a tenant id comes only from a verified API key or console session. Migrations live in `migrations/control/` or `migrations/tenant/`. Enforced for migrations, review for the rest.
- No tenant code runs in Kerby's processes; tenant secrets are encrypted, and logs carry tenant ids, never content.
- The harness is disposable: persist each `message_end` before acting on it; resume from the index, not from harness state.
- Dependencies are `catalog:` exact pins (enforced). Config is read once at startup and fails loudly.
- Parse input at the boundary into types; fail with a clear message; keep strict TypeScript, no `any`.
- Tests run against real Postgres, not mocks; every bug fix ships a regression test.
