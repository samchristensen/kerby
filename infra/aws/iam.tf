data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

locals {
  provider_secret_arns = compact([var.anthropic_api_key_secret_arn, var.openai_api_key_secret_arn])
}

# The execution role pulls images, writes logs and reads the secrets a task is started with.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([for s in aws_secretsmanager_secret.app : s.arn], local.provider_secret_arns)
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task roles: what the running code may do in AWS. S3 only, and only under the tenant prefix `t/`.
resource "aws_iam_role" "task" {
  for_each           = toset(["control", "api", "worker"])
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task_objects" {
  statement {
    sid       = "ReadWriteTenantObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.data.arn}/t/*"]
  }
  statement {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "task_objects" {
  for_each = aws_iam_role.task
  role     = each.value.id
  policy   = data.aws_iam_policy_document.task_objects.json
}

# Only the control service lists and deletes (tenant export and deletion) and checks the bucket exists.
data "aws_iam_policy_document" "control_objects" {
  statement {
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.data.arn]
  }
  statement {
    actions   = ["s3:DeleteObject"]
    resources = ["${aws_s3_bucket.data.arn}/t/*"]
  }
}

resource "aws_iam_role_policy" "control_objects" {
  role   = aws_iam_role.task["control"].id
  policy = data.aws_iam_policy_document.control_objects.json
}

# ECS Exec on the control task is how operators reach the operator API (it has no load balancer).
data "aws_iam_policy_document" "ecs_exec" {
  statement {
    actions   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "control_exec" {
  role   = aws_iam_role.task["control"].id
  policy = data.aws_iam_policy_document.ecs_exec.json
}
