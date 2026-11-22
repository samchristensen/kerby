variable "region" {
  type        = string
  description = "AWS region."
}

variable "environment" {
  type        = string
  default     = "production"
  description = "Names the deployment; also the prefix of every resource, so two environments can share an account."
}

variable "domain_name" {
  type        = string
  description = "Public hostname of the tenant API, e.g. api.kerby.example.com."
}

variable "route53_zone_id" {
  type        = string
  description = "Hosted zone that contains domain_name: used for certificate validation and the alias record."
}

variable "az_count" {
  type    = number
  default = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "Use 2 or 3 availability zones: RDS Multi-AZ and the ALB need at least two."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "nat_gateway_per_az" {
  type        = bool
  default     = false
  description = "One NAT gateway per AZ (resilient, costs more) instead of a single shared one."
}

# --- Postgres -------------------------------------------------------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_max_allocated_storage_gb" {
  type    = number
  default = 1000
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

# --- Images and services --------------------------------------------------------------------------------------------
variable "image_tag" {
  type        = string
  description = "Tag of the control, api and worker images in ECR (a git sha; tags are immutable)."
}

variable "models" {
  type        = string
  description = "Model ids tenants may use, comma separated; the first is the default, e.g. anthropic/claude-sonnet-4-5."
}

variable "anthropic_api_key_secret_arn" {
  type        = string
  default     = null
  description = "Secrets Manager secret (plain string) holding the platform Anthropic key; omit if unused."
}

variable "openai_api_key_secret_arn" {
  type        = string
  default     = null
  description = "Secrets Manager secret (plain string) holding the platform OpenAI key; omit if unused."
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 10
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "worker_max_count" {
  type    = number
  default = 20
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "default_max_concurrent_turns" {
  type    = number
  default = 4
}

variable "auth_cache_seconds" {
  type        = number
  default     = 30
  description = "How long a verified API key is trusted: also how long suspension and revocation take to bite."
}

variable "log_retention_days" {
  type    = number
  default = 30
}

# --- Monitoring -----------------------------------------------------------------------------------------------------
variable "alarm_emails" {
  type        = list(string)
  default     = []
  description = "Addresses subscribed to the alarm topic (each must confirm the subscription email). Wire a pager to the topic too."
}

variable "db_connections_alarm_threshold" {
  type        = number
  default     = 400
  description = "Alarm when Postgres connections exceed this. Keep it below max_connections (about 900 on db.m7g.large)."
}

variable "db_freeable_memory_alarm_bytes" {
  type        = number
  default     = 1073741824
  description = "Alarm when freeable memory drops below this. Every tenant database costs memory: raise it with the tenant count."
}

variable "db_free_storage_alarm_bytes" {
  type        = number
  default     = 21474836480
  description = "Alarm when free storage drops below this (20 GiB)."
}

variable "turn_duration_alarm_ms" {
  type        = number
  default     = 120000
  description = "Alarm when the p95 of turn durations over 5 minutes exceeds this."
}

variable "alb_log_retention_days" {
  type    = number
  default = 90
}
