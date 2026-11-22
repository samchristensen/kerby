locals {
  name = "kerby-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

# Three tiers per AZ: public (ALB, NAT), private (tasks, outbound via NAT), data (RDS, no route out).
resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${local.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 4 + count.index)
  tags              = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_subnet" "data" {
  count             = var.az_count
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, 8 + count.index)
  tags              = { Name = "${local.name}-data-${local.azs[count.index]}" }
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway_per_az ? var.az_count : 1
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = var.nat_gateway_per_az ? var.az_count : 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${local.name}-${count.index}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[var.nat_gateway_per_az ? count.index : 0].id
  }
  tags = { Name = "${local.name}-private-${local.azs[count.index]}" }
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# The data tier has a route table with no default route: the database cannot reach the internet.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name}-data" }
}

resource "aws_route_table_association" "data" {
  count          = var.az_count
  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.data.id
}

# S3 traffic from the tasks stays on the AWS network (and off the NAT gateway's per-GB bill).
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = aws_route_table.private[*].id
  tags              = { Name = "${local.name}-s3" }
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "Public load balancer for the tenant API"
  vpc_id      = aws_vpc.main.id
  lifecycle { create_before_destroy = true }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP (redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description     = "To the API tasks"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

resource "aws_security_group" "tasks" {
  name_prefix = "${local.name}-tasks-"
  description = "Control, api and worker tasks"
  vpc_id      = aws_vpc.main.id
  lifecycle { create_before_destroy = true }

  # Egress: Postgres, S3, ECR, Secrets Manager, and the model providers' APIs.
  egress {
    description = "Outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Declared apart from the groups so they can refer to each other without a cycle.
resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
  description                  = "API port from the load balancer"
}

resource "aws_security_group" "db" {
  name_prefix = "${local.name}-db-"
  description = "Postgres"
  vpc_id      = aws_vpc.main.id
  lifecycle { create_before_destroy = true }

  ingress {
    description     = "Postgres from the tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}
