# One Postgres instance holds the control database and every tenant database (ADR 0004). Multi-AZ gives failover;
# it does not give scale-out: see docs/deploy-aws.md for the database and connection budget.
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.data[*].id
}

resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.name}-pg17-"
  family      = "postgres17"
  lifecycle { create_before_destroy = true }

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
}

resource "random_password" "db_admin" {
  length  = 40
  special = false # goes into a URL
}

data "aws_iam_policy_document" "rds_monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name               = "${local.name}-rds-monitoring"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoring_assume.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  # The admin is rds_superuser, not a true superuser; provisioning is written for that (packages/db/src/cluster.ts).
  db_name  = "kerby_control"
  username = "kerby_admin"
  password = random_password.db_admin.result

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  storage_type          = "gp3"
  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  auto_minor_version_upgrade            = true
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.data.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
}
