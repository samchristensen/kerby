# Docs

The repository is the only memory an agent has: a decision, plan, or convention that is not here does not exist.

| File                                                             | Read when                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [plans/active/](plans/active)                                    | Starting any task. One file per plan: milestones, checkboxes, a log.                                             |
| [plans/tech-debt.md](plans/tech-debt.md)                         | You notice a shortcut or gap you are not fixing now: add it. Fixing one: remove it.                              |
| [principles.md](principles.md)                                   | Before writing code.                                                                                             |
| [adr/](adr)                                                      | Before deciding structure, dependencies, infrastructure, tenancy.                                                |
| [../ARCHITECTURE.md](../ARCHITECTURE.md)                         | Adding or moving anything.                                                                                       |
| [deploy.md](deploy.md)                                           | Running an install: Compose beside a project, Railway, secrets, backups, alerts.                                 |
| [../packages/sdk/INTEGRATION.md](../packages/sdk/INTEGRATION.md) | Integrating an application with Kerby (also published with the SDK); changing a tenant-facing route or contract. |
| [research/](research)                                            | Positioning, pricing, or scoping a feature against the market: dated research.                                   |

## Conventions

- **ADR** `adr/NNNN-title.md`: Status (proposed, accepted, superseded by NNNN), Date, Context, Decision, Consequences.
  Write one for a new service, package, external system, dependency, or a change to a rule. Short beats complete.
- **Plan** `plans/active/NNNN-title.md`; move it to `plans/done/` when every box is ticked. Open questions that block a
  milestone sit at the top of the plan.
- A doc earns its place by stating what the code and `--help` cannot: the reason, the invariant, the gotcha.
