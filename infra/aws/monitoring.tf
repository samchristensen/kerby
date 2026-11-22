# Alarms, a dashboard, log-derived metrics and ALB access logs. Everything alarms to one SNS topic.
locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  service_names = ["control", "api", "worker"]
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.data.id
}

data "aws_iam_policy_document" "alarms_topic" {
  statement {
    sid       = "CloudWatchAndRdsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alarms.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.rds.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  arn    = aws_sns_topic.alarms.arn
  policy = data.aws_iam_policy_document.alarms_topic.json
}

resource "aws_sns_topic_subscription" "email" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# --- Load balancer ------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-api-5xx"
  alarm_description   = "The API is answering 5xx (from the targets). Look at the api logs: `{ $.level = \"error\" }`."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_elb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "The load balancer itself is failing requests (no healthy targets, timeouts)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${local.name}-api-latency-p95"
  alarm_description   = "API p95 response time above 2 s for 10 minutes. (Event streams answer headers at once, so this is request latency.)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  alarm_name          = "${local.name}-api-unhealthy-targets"
  alarm_description   = "An API task is failing its health check."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.api.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- ECS services -------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  for_each            = { control = 1, api = var.api_desired_count, worker = var.worker_desired_count }
  alarm_name          = "${local.name}-${each.key}-running-tasks"
  alarm_description   = "Fewer ${each.key} tasks are running than the minimum (${each.value}): crash loop, failed deployment or capacity."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.key }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = each.value
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  depends_on          = [aws_ecs_service.control, aws_ecs_service.api, aws_ecs_service.worker]
}

resource "aws_cloudwatch_metric_alarm" "service_cpu" {
  for_each            = toset(local.service_names)
  alarm_name          = "${local.name}-${each.key}-cpu"
  alarm_description   = "${each.key} CPU above 85% for 15 minutes (autoscaling is at 60%: it is at its maximum or too slow)."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.key }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "service_memory" {
  for_each            = toset(local.service_names)
  alarm_name          = "${local.name}-${each.key}-memory"
  alarm_description   = "${each.key} memory above 85% for 15 minutes: the next step is an OOM kill."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.key }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# --- RDS ----------------------------------------------------------------------------------------------------------
locals {
  rds_alarms = {
    cpu = {
      metric = "CPUUtilization", statistic = "Average", op = "GreaterThanThreshold", threshold = 80, periods = 3, period = 300
      text   = "Postgres CPU above 80% for 15 minutes."
    }
    freeable-memory = {
      metric = "FreeableMemory", statistic = "Minimum", op = "LessThanThreshold", threshold = var.db_freeable_memory_alarm_bytes, periods = 3, period = 300
      text   = "Postgres freeable memory is low. Each tenant database costs memory: resize the instance or plan a second cluster."
    }
    free-storage = {
      metric = "FreeStorageSpace", statistic = "Minimum", op = "LessThanThreshold", threshold = var.db_free_storage_alarm_bytes, periods = 1, period = 300
      text   = "Postgres free storage is low (storage autoscaling may be at its maximum)."
    }
    connections = {
      metric = "DatabaseConnections", statistic = "Maximum", op = "GreaterThanThreshold", threshold = var.db_connections_alarm_threshold, periods = 3, period = 60
      text   = "Postgres connections are high. Each api or worker task holds up to 50 tenant pools x 2 connections, plus one per open event stream."
    }
    write-latency = {
      metric = "WriteLatency", statistic = "Average", op = "GreaterThanThreshold", threshold = 0.05, periods = 3, period = 300
      text   = "Postgres write latency above 50 ms."
    }
    read-latency = {
      metric = "ReadLatency", statistic = "Average", op = "GreaterThanThreshold", threshold = 0.05, periods = 3, period = 300
      text   = "Postgres read latency above 50 ms."
    }
    disk-queue = {
      metric = "DiskQueueDepth", statistic = "Average", op = "GreaterThanThreshold", threshold = 20, periods = 3, period = 300
      text   = "Postgres disk queue depth is high: IO is saturated."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each            = local.rds_alarms
  alarm_name          = "${local.name}-rds-${each.key}"
  alarm_description   = each.value.text
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# Failover, maintenance, low storage, backup problems.
resource "aws_db_event_subscription" "main" {
  name             = local.name
  sns_topic        = aws_sns_topic.alarms.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["availability", "failover", "failure", "low storage", "maintenance", "notification", "recovery", "backup", "configuration change"]
  depends_on       = [aws_sns_topic_policy.alarms]
}

# --- Application signals from the JSON logs -----------------------------------------------------------------------
# Log lines are `{"level":..,"msg":..,"tenantId":..}` (packages/observability): metrics are derived from them.
locals {
  log_metrics = {
    app-errors-api = {
      group = "api", pattern = "{ $.level = \"error\" }"
      text  = "api logged an error. Query: fields @timestamp, msg, tenantId, errorName, errorMessage | filter level = \"error\""
    }
    app-errors-worker = {
      group = "worker", pattern = "{ $.level = \"error\" }"
      text  = "worker logged an error."
    }
    app-errors-control = {
      group = "control", pattern = "{ $.level = \"error\" }"
      text  = "control logged an error (a failed provisioning, usually)."
    }
    turn-failed = {
      group = "worker", pattern = "{ $.msg = \"turn failed for good\" }"
      text  = "A turn exhausted its attempts: a customer got no answer. See lastError on the conversation."
    }
    lease-lost = {
      group = "worker", pattern = "{ $.msg = \"lease lost; abandoning the run\" }"
      text  = "Runs are losing their lease: workers are overloaded or stalled (a lapsed lease is retried by another worker)."
    }
    scheduler-trouble = {
      group = "worker", pattern = "{ ($.msg = \"sweep failed\") || ($.msg = \"looking for work failed\") }"
      text  = "The worker cannot find work (control database or tenant database trouble)."
    }
    heartbeat-failed = {
      group = "worker", pattern = "{ $.msg = \"lease heartbeat failed; aborting run\" }"
      text  = "A running turn could not extend its lease."
    }
    api-server-errors = {
      group = "api", pattern = "{ ($.msg = \"request\") && ($.status >= 500) }"
      text  = "api answered 5xx to an authenticated request (also visible per tenant: filter on tenantId)."
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "signal" {
  for_each       = local.log_metrics
  name           = each.key
  log_group_name = aws_cloudwatch_log_group.service[each.value.group].name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = "Kerby/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "signal" {
  for_each            = { for k, v in local.log_metrics : k => v if k != "lease-lost" && k != "heartbeat-failed" }
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.text
  namespace           = "Kerby/${var.environment}"
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.key == "turn-failed" ? 1 : 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.signal]
}

# Lease losses and failed heartbeats are a rate, not an event: a few are normal during a deployment.
resource "aws_cloudwatch_metric_alarm" "lease" {
  for_each            = toset(["lease-lost", "heartbeat-failed"])
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = local.log_metrics[each.key].text
  namespace           = "Kerby/${var.environment}"
  metric_name         = each.key
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.signal]
}

# How long turns take (the worker logs `turn completed` with durationMs) and how many finish.
resource "aws_cloudwatch_log_metric_filter" "turn_duration" {
  name           = "turn-duration-ms"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.msg = \"turn completed\" }"
  metric_transformation {
    name      = "turn-duration-ms"
    namespace = "Kerby/${var.environment}"
    value     = "$.durationMs"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "turn_duration" {
  alarm_name          = "${local.name}-turn-duration-p95"
  alarm_description   = "Turn p95 above the threshold: a slow model provider, a slow tool or an overloaded worker."
  namespace           = "Kerby/${var.environment}"
  metric_name         = "turn-duration-ms"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.turn_duration_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  depends_on          = [aws_cloudwatch_log_metric_filter.turn_duration]
}

# --- ALB access logs ----------------------------------------------------------------------------------------------
data "aws_elb_service_account" "main" {}

resource "aws_s3_bucket" "alb_logs" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-${var.region}-alb-logs"
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ALB log delivery supports SSE-S3 only, not KMS.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration { days = var.alb_log_retention_days }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/alb/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.main.arn]
    }
    # Regions opened after 2022 deliver ALB logs as a service principal instead of a regional account.
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.alb_logs.arn, "${aws_s3_bucket.alb_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket     = aws_s3_bucket.alb_logs.id
  policy     = data.aws_iam_policy_document.alb_logs.json
  depends_on = [aws_s3_bucket_public_access_block.alb_logs]
}

# --- Dashboard ----------------------------------------------------------------------------------------------------
resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type       = "text", x = 0, y = 0, width = 24, height = 2
        properties = { markdown = "# ${local.name}\nAlarms notify the SNS topic `${aws_sns_topic.alarms.name}`. Logs: `/kerby/${var.environment}/{api,worker,control}`. Every log line is JSON with `tenantId`; never message content." }
      },
      {
        type = "metric", x = 0, y = 2, width = 8, height = 6
        properties = {
          title = "API requests and errors", region = var.region, stat = "Sum", period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.api.arn_suffix],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
            [".", "HTTPCode_Target_4XX_Count", ".", "."],
            [".", "HTTPCode_ELB_5XX_Count", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 2, width = 8, height = 6
        properties = {
          title = "API latency", region = var.region, period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.api.arn_suffix, { stat = "p50" }],
            ["...", { stat = "p95" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 2, width = 8, height = 6
        properties = {
          title   = "Running tasks", region = var.region, stat = "Minimum", period = 60
          metrics = [for s in local.service_names : ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", s]]
        }
      },
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title   = "Service CPU %", region = var.region, stat = "Average", period = 60
          metrics = [for s in local.service_names : ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", s]]
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title   = "Service memory %", region = var.region, stat = "Average", period = 60
          metrics = [for s in local.service_names : ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", s]]
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title = "Turns: duration (ms) and failures", region = var.region, period = 300
          metrics = [
            ["Kerby/${var.environment}", "turn-duration-ms", { stat = "p50" }],
            ["...", { stat = "p95" }],
            ["Kerby/${var.environment}", "turn-failed", { stat = "Sum", yAxis = "right" }],
            [".", "lease-lost", { stat = "Sum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 14, width = 8, height = 6
        properties = {
          title = "Postgres CPU % and connections", region = var.region, period = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier, { stat = "Average" }],
            [".", "DatabaseConnections", ".", ".", { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 8, y = 14, width = 8, height = 6
        properties = {
          title = "Postgres memory and storage (bytes)", region = var.region, period = 300
          metrics = [
            ["AWS/RDS", "FreeableMemory", "DBInstanceIdentifier", aws_db_instance.main.identifier, { stat = "Minimum" }],
            [".", "FreeStorageSpace", ".", ".", { stat = "Minimum", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 16, y = 14, width = 8, height = 6
        properties = {
          title = "Postgres latency (s) and IO queue", region = var.region, period = 60, stat = "Average"
          metrics = [
            ["AWS/RDS", "ReadLatency", "DBInstanceIdentifier", aws_db_instance.main.identifier],
            [".", "WriteLatency", ".", "."],
            [".", "DiskQueueDepth", ".", ".", { yAxis = "right" }],
          ]
        }
      },
      {
        type = "log", x = 0, y = 20, width = 24, height = 6
        properties = {
          title = "Recent errors and warnings (all services)", region = var.region, view = "table"
          query = "SOURCE '${aws_cloudwatch_log_group.service["api"].name}' | SOURCE '${aws_cloudwatch_log_group.service["worker"].name}' | SOURCE '${aws_cloudwatch_log_group.service["control"].name}' | fields @timestamp, level, msg, tenantId, errorName, errorMessage | filter level = \"error\" or level = \"warn\" | sort @timestamp desc | limit 50"
        }
      },
      {
        type = "log", x = 0, y = 26, width = 12, height = 6
        properties = {
          title = "Slowest turns (worker)", region = var.region, view = "table"
          query = "SOURCE '${aws_cloudwatch_log_group.service["worker"].name}' | fields @timestamp, tenantId, durationMs, messages, attempt | filter msg = \"turn completed\" | sort durationMs desc | limit 20"
        }
      },
      {
        type = "log", x = 12, y = 26, width = 12, height = 6
        properties = {
          title = "Requests per tenant (api, last period)", region = var.region, view = "table"
          query = "SOURCE '${aws_cloudwatch_log_group.service["api"].name}' | filter msg = \"request\" | stats count(*) as requests, sum(status >= 500) as errors, avg(durationMs) as avgMs by tenantId | sort requests desc | limit 25"
        }
      },
    ]
  })
}
