# 0012. Recovery and availability: nightly backups, one Postgres, HA when an SLA is sold

- Status: superseded by [0024](0024-self-hosted-single-tenant.md)
- Date: 2026-11-22

## Context

[ADR 0007](0007-railway-hosting.md) left Kerby on one Railway Postgres instance on one volume with no backups, and a bucket
nobody copies. Plan 0003 (A1, A3, H1) asks how much data may be lost (RPO) and for how long Kerby may be down (RTO).
The owner decided: nightly backups. Kerby has no paying tenants yet.

What Railway's Postgres offers today (CLI 5.62.1, `railway postgres`): a scheduled volume backup (daily kept 6 days,
weekly, monthly) and on-demand backups, restored onto the same volume; point-in-time recovery (`pitr enable`: continuous
WAL archiving to a bucket, restore to a time into a new service); high-availability clusters (`ha convert --replicas n`,
switchover); PgBouncer (`pgbouncer add`). Railway buckets have no versioning, lifecycle rules or backups.

## Decision

- **RPO 24 hours, nightly.** The Postgres volume has a daily backup schedule (kept 6 days), set with
  `railway postgres pitr schedule set --daily --service Postgres` (the IaC file cannot hold it, see its header). Bucket
  objects are copied nightly to a second bucket in another region (plan 0003, A3; ADR 0013).
- **RTO measured, not promised.** Restore drill (2026-11-22, a copy environment): marker row, on-demand backup, a second
  row, `railway postgres pitr backup restore`: the database answered again with only the first row after 77 s (a small
  database; time grows with size). A full recovery also needs the bucket copy and the secrets private key (kept outside
  Railway, docs/deploy.md).
- **One Postgres instance, no replica, for now.** A failed instance is an outage until Railway restarts it. HA multiplies
  the database's cost and is not needed before a tenant pays for availability.
- **Next steps, with their triggers.** The first paying tenant: enable PITR (RPO minutes instead of a day). The first
  availability commitment (an SLA): `railway postgres ha convert`, re-run `make multitenant` and the restore drill
  against the cluster, and record the measured failover time here.
- **Admin stays a superuser.** Railway's `postgres` role is a superuser, standalone or HA. The provisioning path for a
  non-superuser admin (the admin joining each tenant role) is deleted; `reassignOwned` stays, because a superuser cannot
  `REASSIGN OWNED` its own objects. Moving to a host without a superuser brings it back, from history.
- **Nothing sleeps.** `deploy.sleepApplication` stays off on `api` and `worker`. The worker sweeps every 10 s and runs
  every scheduled task, so it is never idle; the api holds a `LISTEN` connection per tenant with open streams, and a
  sleeping api would charge the next tenant request a cold start to save the cost of one small container. Decided
  without a trial (plan 0003, H2): revisit if the api's idle cost shows up on the bill.
- Rejected: a managed Postgres outside Railway (a second provider, private networking over the internet, and the
  non-superuser path again); WAL archiving built into a custom Postgres image (Railway's PITR does it).

## Consequences

- Up to a day of conversations can be lost to a volume failure until PITR is on.
- A restore replaces the volume's contents: take an on-demand backup first (`railway postgres pitr backup create`).
- Backups belong to the volume: deleting the `Postgres` service or its volume deletes them. Never do either in production.
