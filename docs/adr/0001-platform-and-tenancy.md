# 0001. Kerby is a multi-tenant platform for customers, extracted from lochmoore

- Status: proposed
- Date: 2026-11-21

## Context

Lochmoore's `kerby-api` and `kerby-worker` run chat agents for one product. Several products want the same
intelligence, and Kerby should be sellable as a service to outside customers. Lochmoore has no tenant concept: the
only scope is `user_id`, `user-api` is one product's login system, and the worker hard-wires its tools by
environment variable.

## Decision

- Kerby is a separate project and a separately deployed service. Customers call it over HTTP; the same images run
  locally in Docker and hosted, so local development is the production code path.
- **A tenant is a customer, and untrusted.** Its data, keys, tools, and spend are invisible and unreachable to
  every other tenant, including through a bug in Kerby. Isolation is structural (a database and a key prefix per
  tenant, see [0004](0004-database-per-tenant.md)), not a filter someone has to remember.
- A tenant authenticates server-to-server with an API key and names its end users by its own `externalUserId`.
  Kerby does not log end users in.
- A tenant registers its **tools** (MCP server URL plus auth) and optionally its own model keys. Tenant-supplied code
  and URLs are never trusted: no tenant code runs in Kerby's processes, and outbound calls go through an egress guard.
- Kerby is extracted from lochmoore by porting, not by sharing code. Lochmoore becomes the first tenant.

## Consequences

- Operating cost per tenant is real (a database, a polling presence); [0004](0004-database-per-tenant.md) bounds it.
- Commercial readiness (billing, console, export and deletion, audit) is in scope of the plan, not an afterthought.

## Open

- Pricing model and billing provider (plan 0001, M9).
- Hosted deployment target and where its config lives (outside this repo).
- End-user identity for a customer with none of its own: out of scope until one asks.
