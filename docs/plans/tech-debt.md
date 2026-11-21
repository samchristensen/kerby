# Tech debt

One line each: what, why it matters, what fixes it. Remove the line in the commit that pays it.

- `knip` (dead code, unused dependencies) is not wired into `make check`. Add it with the first service.
- The import scanner in `check-architecture.ts` is regex-based and also reads strings in comments. Replace it with a parser if a false positive appears.
- No automated doc-freshness pass. A recurring agent task could compare ADR claims and AGENTS.md invariants with the checks.
- `AgentRuntime` has one adapter and no conformance suite. Write the suite when the second adapter lands.
- A tenant role can still `connect` to databases `public` may connect to (the control database, `postgres`). It has no grants there, so it reads nothing, but `make up` should `revoke connect ... from public` on the control database. Fix with the local stack (T11).
- `reassignOwned` (packages/db) moves ownership by hand because a superuser cannot `REASSIGN OWNED`; a hosted cluster whose admin role is not a superuser needs the admin to be a member of each tenant role first. Settle when the hosting target is chosen.
- A conversation read fetches every message body from S3 (N requests). Cache small bodies or page the read when it shows up in a profile.
