resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  configuration {
    execute_command_configuration { logging = "DEFAULT" }
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["control", "api", "worker"])
  name              = "/kerby/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
}

locals {
  image = { for k, r in aws_ecr_repository.service : k => "${r.repository_url}:${var.image_tag}" }

  secret_ref = { for k, s in aws_secretsmanager_secret.app : k => s.arn }

  # Settings every service shares. `S3_ENDPOINT` and the S3 keys are left unset on purpose: the SDK then talks to S3
  # with the task role. The database CA bundle is in the image (NODE_EXTRA_CA_CERTS).
  common_env = {
    S3_BUCKET         = aws_s3_bucket.data.bucket
    S3_REGION         = var.region
    TENANT_DB_SSLMODE = "verify-full"
    KERBY_ENVIRONMENT = "production"
  }
  common_secrets = {
    CONTROL_DATABASE_URL = local.secret_ref.control_database_url
    TENANT_DB_SECRET     = local.secret_ref.tenant_db_secret
  }

  provider_secrets = merge(
    var.anthropic_api_key_secret_arn == null ? {} : { ANTHROPIC_API_KEY = var.anthropic_api_key_secret_arn },
    var.openai_api_key_secret_arn == null ? {} : { OPENAI_API_KEY = var.openai_api_key_secret_arn },
  )

  services = {
    control = {
      port = 8081
      env = {
        PORT         = "8081"
        CLUSTER_HOST = local.db_host
        CLUSTER_PORT = "5432"
        EXPORT_DIR   = "/var/lib/kerby/exports"
      }
      secrets = {
        OPERATOR_TOKEN    = local.secret_ref.operator_token
        CLUSTER_ADMIN_URL = local.secret_ref.cluster_admin_url
      }
    }
    api = {
      port = 8080
      env = {
        PORT               = "8080"
        MODELS             = var.models
        AUTH_CACHE_SECONDS = tostring(var.auth_cache_seconds)
      }
      secrets = {}
    }
    worker = {
      port = 8082
      env = {
        HEALTH_PORT                  = "8082"
        DEFAULT_MAX_CONCURRENT_TURNS = tostring(var.default_max_concurrent_turns)
      }
      secrets = local.provider_secrets
    }
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  # The images are built for linux/amd64 (`make aws-push`).
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  dynamic "ephemeral_storage" {
    for_each = each.key == "control" ? [1] : []
    content { size_in_gib = 50 } # tenant exports are written here before an operator collects them
  }

  container_definitions = jsonencode([{
    name         = each.key
    image        = local.image[each.key]
    essential    = true
    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
    # A worker gets time to stop claiming and let running turns finish (the scheduler waits 10 s); the rest is taken
    # over by another worker when their leases lapse.
    stopTimeout = 60
    environment = [for k, v in merge(local.common_env, each.value.env) : { name = k, value = v }]
    secrets     = [for k, v in merge(local.common_secrets, each.value.secrets) : { name = k, valueFrom = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "control" {
  name                   = "control"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.service["control"].arn
  desired_count          = 1
  launch_type            = "FARGATE"
  enable_execute_command = true

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service["api"].arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"
  # The API needs the control service's schema (migrated at its startup).
  health_check_grace_period_seconds = 90

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle { ignore_changes = [desired_count] } # autoscaling owns it
  depends_on = [aws_lb_listener.https, aws_ecs_service.control]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service["worker"].arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # Replace tasks without dropping below the current count: a killed worker's turns move, but do not stall.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_ecs_service.control]
}

# Autoscaling on CPU. Workers are stateless: any worker takes any turn (ADR 0003).
resource "aws_appautoscaling_target" "scaled" {
  for_each = {
    api    = { min = var.api_desired_count, max = var.api_max_count }
    worker = { min = var.worker_desired_count, max = var.worker_max_count }
  }
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${each.key}"
  min_capacity       = each.value.min
  max_capacity       = each.value.max
  depends_on         = [aws_ecs_service.api, aws_ecs_service.worker]
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.scaled
  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = each.value.service_namespace
  scalable_dimension = each.value.scalable_dimension
  resource_id        = each.value.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
