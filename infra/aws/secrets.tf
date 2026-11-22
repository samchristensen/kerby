# Secrets are generated here and injected into tasks by ECS from Secrets Manager. Their values live in Terraform state
# (encrypted S3 backend): protect that bucket like the secrets themselves.
resource "random_password" "operator_token" {
  length  = 48
  special = false
}

# Derives every tenant database role's password (ADR 0004). Changing it locks every tenant out of its database:
# see docs/deploy-aws.md before rotating.
resource "random_password" "tenant_db_secret" {
  length  = 48
  special = false
}

locals {
  db_host = aws_db_instance.main.address
  secrets = {
    control_database_url = "postgres://kerby_admin:${random_password.db_admin.result}@${local.db_host}:5432/kerby_control?sslmode=verify-full"
    cluster_admin_url    = "postgres://kerby_admin:${random_password.db_admin.result}@${local.db_host}:5432/postgres?sslmode=verify-full"
    operator_token       = random_password.operator_token.result
    tenant_db_secret     = random_password.tenant_db_secret.result
  }
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secrets
  name                    = "kerby/${var.environment}/${each.key}"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = each.value
}
