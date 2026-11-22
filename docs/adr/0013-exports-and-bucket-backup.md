# 0013. Tenant exports in their own bucket; a nightly copy of the bucket

- Status: proposed
- Date: 2026-11-22

## Context

Tenant exports were written to the control container's disk, which a redeploy clears, and never deleted. Message bodies
live only in the bucket `kerby`, so a Postgres restore alone brings back an index that may point at nothing. Railway
buckets (Tigris, S3-compatible) offer presigned URLs, copy and multipart uploads, but no object versioning, object lock,
lifecycle rules, replication or backups; each bucket has its own keys; regions are `sjc`, `iad`, `ams`, `sin`. `kerby` is
in `iad`.

## Decision

- **Exports go to a bucket of their own, `kerby-exports`** (`iad`), whose keys only `control` holds (`EXPORT_S3_*`). An
  export is `<tenantId>/<stamp>.dump` (`pg_dump`, custom format) and `<tenantId>/<stamp>.objects.json` (the tenant's object
  keys and sizes). The dump goes through a temporary file, uploaded in 32 MiB parts (no single-put 5 GiB cap; 10,000 parts
  cap one dump at 320 GiB) and removed either way. The operator API answers with presigned GET URLs valid for 24 hours
  (`expiresAt`) and audits each URL issued (`export.url_issued`): a URL is a credential to the tenant's data.
- **Exports are kept 30 days**, a deleted tenant's too (an export may be the hand-over copy). With no lifecycle rules,
  control deletes exports whose stamp is older than that at start and every night; any instance may, deleting twice is
  harmless. The stamp comes from control's clock, so retention is tested with an injected one.
- **The backup is a second bucket, `kerby-backup`, in another region (`sjc`)**, keys held only by `control`
  (`BACKUP_S3_*`). Every night at 03:00 UTC control copies each active or suspended tenant's objects that are missing from
  the backup or differ in size or ETag. The buckets have different keys, so the bytes pass through control (no server-side
  copy). A Postgres transaction-scoped advisory lock lets one control instance run at a time; the operator API runs it on
  demand (`POST /v1/operator/backup`, 409 while another run holds the lock).
- **Deletion reaches the backup.** The prefix of a tenant whose status is `deleted` is removed from the backup at the next
  run. A prefix with no tenant row is left alone: after a control database restore, it may be the only copy of a tenant
  created since. Objects deleted from `kerby` for a live tenant stay in the backup (nothing deletes single objects today).
- **Restore copies only what is missing** (`POST /v1/operator/backup/restore`, one tenant or every live one): it never
  overwrites an object in `kerby`, so it is safe to repeat while tenants work.
- **One door to S3.** `packages/blobs` keeps `Blobs` (a tenant context on every call, for api and worker) and adds
  `Bucket`, raw keys for `control` only (tenant prefixes, exports, the copy), and `copyObjects`.
- Rejected: Railway bucket versioning or replication (not offered); a lifecycle rule for retention (not offered); a copy
  in the same region (a regional outage takes both); `@aws-sdk/lib-storage` for multipart uploads (a dependency for 40
  lines); an export volume on control (one volume per service on Railway, lost with the service, and no URL to hand over).

## Consequences

- RPO for message bodies is a day: objects written since the last nightly run are not in the backup.
- A presigned URL works for 24 hours for anyone who has it; there is no endpoint to issue new URLs for an existing export
  (export again while the tenant exists).
- Copying through control costs egress from `iad` and ingress to `sjc` for every new object, once.
- Locally both buckets live on the one RustFS with its keys; in production each has its own.
