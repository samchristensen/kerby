# Tech debt

One line each: what, why it matters, what fixes it. Remove the line in the commit that pays it.

- `knip` (dead code, unused dependencies) is not wired into `make check`. Add it with the first service.
- The import scanner in `check-architecture.ts` is regex-based and also reads strings in comments. Replace it with a parser if a false positive appears.
- No automated doc-freshness pass. A recurring agent task could compare ADR claims and AGENTS.md invariants with the checks.
- `AgentRuntime` has one adapter and no conformance suite. Write the suite when the second adapter lands.
- A tenant role can still `connect` to the maintenance database `postgres` (the control database is restricted at control startup). It has no grants there.
- `reassignOwned` (packages/db) moves ownership by hand because a superuser cannot `REASSIGN OWNED`; a hosted cluster whose admin role is not a superuser needs the admin to be a member of each tenant role first. Settle when the hosting target is chosen.
- A conversation read fetches every message body from S3 (N requests). Cache small bodies or page the read when it shows up in a profile.
- M3 asks that `make test` run against the real stack and that logs and traces be agent-queryable. Tests use disposable containers; logs are JSON on stdout (`make logs`). Add a log sink an agent can query when it is needed.
- AWS (ADR 0007): the infra is only `terraform validate`d; apply it to a staging account and fix what a real plan finds before production.
- AWS: every tenant role's password derives from one shared secret held by api, worker and control. Store per-tenant credentials, with a rotation path, in `packages/secrets`.
- AWS: tenant exports are written to the control task's ephemeral disk. Upload them to a separate, access-logged S3 location and return a presigned URL.
- AWS: no WAF and no edge rate limiting. Alarm thresholds are first guesses: tune them against real traffic. No external synthetic check (a Route 53 health check or CloudWatch Synthetics canary).
- AWS: S3 versioning keeps deleted tenant objects 30 days; decide whether deletion must be immediate (then expire noncurrent versions of `t/<tenant>/` on delete).
