# Deploying to AWS

What `infra/aws` creates and how to run it. Why: [ADR 0007](adr/0007-aws-hosting.md). Status: validated with
`terraform validate` only (`make infra`); it has not been applied to an account.

## Created

| Layer   | Resources                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Network | VPC, 2 or 3 AZs, public / private / data subnets, one NAT gateway (or one per AZ), S3 gateway endpoint |
| Edge    | ALB, ACM certificate (DNS validated in Route 53), alias record, HTTP to HTTPS redirect                 |
| Compute | ECS cluster, Fargate services `api`, `worker`, `control`, CPU autoscaling for api and worker           |
| Data    | RDS PostgreSQL 17 Multi-AZ, S3 bucket, KMS key                                                         |
| Secrets | Secrets Manager: admin database URLs, operator token, tenant-database secret                           |
| Images  | ECR repositories `kerby/<environment>/{control,api,worker}`                                            |

## First deployment

You need an AWS account and credentials, a Route 53 hosted zone, Terraform 1.9+, the AWS CLI and Docker with buildx.

1. Create an S3 bucket and DynamoDB table for Terraform state (encrypted, versioned: the state contains the generated secrets).
2. `cd infra/aws`, copy `terraform.tfvars.example` to `terraform.tfvars` and fill it in.
3. `terraform init -backend-config=...` (see `versions.tf`).
4. Create the repositories first: `terraform apply -target=aws_ecr_repository.service -target=aws_kms_key.data`.
5. From the repo root, with a clean git tree: `AWS_REGION=<region> make aws-push`. It prints `image_tag = "<sha>"`; put it in `terraform.tfvars`.
6. `terraform apply`. The `control` service migrates the control database and creates the tenant template at start; `api` and
   `worker` wait for it (the api health-check grace is 90 s).
7. Provision the first tenant through the operator API, from inside the control task (there is no public route):

   ```sh
   aws ecs execute-command --cluster kerby-<environment> --task <task-id> --container control --interactive \
     --command "node --input-type=module -e 'const r = await fetch(\"http://127.0.0.1:8081/v1/operator/tenants\", { method: \"POST\", headers: { authorization: \"Bearer \" + process.env.OPERATOR_TOKEN, \"content-type\": \"application/json\" }, body: JSON.stringify({ name: \"acme\" }) }); console.log(await r.text())'"
   ```

   The response holds the tenant's API key once. Then `curl https://<domain_name>/v1/conversations -H "authorization: Bearer <key>" -d '{}'`.

## Deploying a change

`make aws-push` (new tag), set `image_tag`, `terraform apply`. ECS replaces tasks with a circuit breaker that rolls back a
failing deployment. After a release that adds tenant migrations, run the fan-out (`POST /v1/operator/migrate`, same way
as above): code must tolerate schema versions n and n-1 while it runs.

## Monitoring

Set `alarm_emails` (each address must confirm its subscription) and subscribe a pager or chat tool to the `alarm_topic_arn` output.
The `dashboard` output links to the CloudWatch dashboard.

| Alarm                                                                                                | Means                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `api-5xx`, `alb-5xx`, `api-latency-p95`, `api-unhealthy-targets`                                     | the API is failing, slow, or a task fails its health check                                        |
| `<service>-running-tasks`                                                                            | fewer tasks than the minimum: crash loop, failed deployment, capacity                             |
| `<service>-cpu`, `<service>-memory`                                                                  | above 85% for 15 minutes                                                                          |
| `rds-cpu`, `-freeable-memory`, `-free-storage`, `-connections`, `-read/write-latency`, `-disk-queue` | the Postgres budget is running out; every tenant is a database                                    |
| `turn-failed`                                                                                        | a turn used all its attempts: a customer got no answer (`lastError` on the conversation says why) |
| `lease-lost`, `heartbeat-failed`                                                                     | runs losing their lease: workers stalled or overloaded                                            |
| `scheduler-trouble`                                                                                  | the worker cannot find work                                                                       |
| `app-errors-*`, `api-server-errors`                                                                  | any `level=error` log line; authenticated requests answered 5xx                                   |
| `turn-duration-p95`                                                                                  | slow turns: provider, tool or worker saturation                                                   |

Logs are JSON with `tenantId` and never message content. Useful Logs Insights queries (the dashboard has the first three):
`filter level = "error"`, slowest turns (`msg = "turn completed"`, sort by `durationMs`), requests per tenant
(`msg = "request"`, `stats count(*) by tenantId`), and one tenant's activity (`filter tenantId = "<id>"`). ALB access logs
are in the `*-alb-logs` bucket for 90 days (`alb_log_retention_days`).

## Database roles

The control service connects to Postgres as the RDS admin (`kerby_admin`), creates the limited `kerby_app` role at start
(migration 0002) and sets its password. `api` and `worker` connect to the control database as `kerby_app`: it can read tenants
and keys, mark a key used, and insert usage, and nothing else (no `tenant_secrets`, no audit log, no writes to tenants). At
start, control also revokes `connect` on the control database from `public`, so a tenant role cannot even open it. A tenant
database is always opened as that tenant's own role.

## Budgets to know

- **Postgres**: about 1 GiB of memory per 200 tenant databases was measured locally; every tenant is a database, so size
  `db_instance_class` for the tenant count you expect and watch `FreeableMemory`. One instance is also one connection
  budget: each api or worker task holds up to 50 tenant pools of 2 connections, plus one dedicated connection per open event
  stream. Keep `tasks x 100 + streams` well below `max_connections`.
- **Provider keys**: create the secrets yourself and pass their ARNs (`anthropic_api_key_secret_arn`, ...). Models tenants
  may use are `models`.

## Do not do

- Do not change `tenant_db_secret` (`random_password.tenant_db_secret`) on a live system: every tenant role's password derives
  from it, so every tenant would be locked out until each role's password is reset to the new derivation.
- Do not expose `control` through a load balancer.
- Do not delete the RDS instance with `db_deletion_protection = true` still set, and keep the final snapshot.

## Known gaps

See `docs/plans/tech-debt.md`: no WAF or rate limiting at the edge, `api` and `worker` still derive every tenant role's
password from one shared secret, tenant exports land on the control task's ephemeral disk, S3 versioning delays deletion for
30 days, no synthetic external check, a single RDS instance. Alarm thresholds are starting points: tune them with real traffic.
