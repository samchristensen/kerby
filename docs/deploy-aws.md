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

See `docs/plans/tech-debt.md`: no WAF or rate limiting at the edge, `api` and `worker` hold admin database credentials,
tenant exports land on the control task's ephemeral disk, S3 versioning delays deletion for 30 days, no alarms or dashboards,
a single RDS instance.
