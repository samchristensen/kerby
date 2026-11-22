# 0007. Hosting: raw AWS, Terraform, ECS Fargate, one RDS Postgres, S3

- Status: proposed
- Date: 2026-11-22

## Context

Plan 0001 left the hosting target open. The target is AWS without a platform layer. The same images run locally
(Compose) and hosted, so hosting must need nothing the images do not already do.

## Decision

- **Terraform** (`infra/aws`, provider versions pinned, S3 backend configured per environment) over CDK or CloudFormation:
  boring, reviewable, no extra dependency tree in the catalog.
- **ECS on Fargate**, three services from three ECR repositories (immutable tags, scan on push): `api` behind an ALB
  (ACM certificate, TLS 1.3 policy, HTTP redirects), `worker` (stateless, autoscaled on CPU, replaced without dropping
  below the running count), `control` (one task, **no load balancer**: operators reach the operator API with ECS Exec).
  Tasks run in private subnets and reach S3 through a gateway endpoint.
- **One RDS for PostgreSQL 17 instance, Multi-AZ**, in a data subnet tier with no route out, TLS forced
  (`rds.force_ssl`), encrypted with a customer-managed KMS key, 14 days of backups. It holds the control database and
  every tenant database. The admin role is `rds_superuser`, not a superuser: provisioning therefore makes the admin a
  member of each tenant role, re-owns objects with `ALTER ... OWNER` (not `REASSIGN OWNED`), and restricts connect last.
- **S3**: one bucket, versioned, SSE-KMS, public access blocked, TLS-only policy. Tasks use their **task role**
  (no static keys): read and write under `t/*`; only `control` may list and delete.
- **Secrets Manager** holds generated secrets (admin database URLs, operator token, tenant-database secret) and the
  optional provider keys; ECS injects them as environment variables, which is what `@kerby/config` reads. Services
  connect to Postgres with `sslmode=verify-full`; the images carry the Amazon RDS CA bundle.

## Consequences

- One instance is one failure domain and one connection and memory budget (plan 0001, S4/S5 and the 200-tenant run: about
  1 GiB at 200 tenant databases). Scaling out means a second cluster; a tenant row already names its host, but the
  services know only one cluster today.
- `api` and `worker` hold the cluster admin credentials in their control-database URL, and the shared tenant-database secret
  derives every tenant role's password. A compromised task can reach every tenant. Narrower roles for the control database
  and per-tenant stored credentials are follow-ups (tech debt).
- S3 versioning keeps deleted tenant objects as noncurrent versions for 30 days: a deletion guarantee shorter than that
  needs the lifecycle rule changed.
- Not verified against a real AWS account: this configuration passes `terraform validate` only.

## Rejected

- EKS: more to operate than three stateless services justify. EC2 with Docker: hosts to patch.
- Aurora: better failover and storage growth, but not needed before the single-instance limits are reached.
- A load balancer in front of `control`: the operator API should not be reachable from the internet.
