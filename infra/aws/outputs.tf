output "api_url" {
  value = "https://${var.domain_name}"
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "rds_endpoint" {
  value = aws_db_instance.main.address
}

output "data_bucket" {
  value = aws_s3_bucket.data.bucket
}

output "operator_token_secret_arn" {
  value       = aws_secretsmanager_secret.app["operator_token"].arn
  description = "Read it with: aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text"
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}
