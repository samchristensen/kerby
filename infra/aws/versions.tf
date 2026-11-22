terraform {
  required_version = ">= 1.9"

  required_providers {
    aws    = { source = "hashicorp/aws", version = "= 6.73.0" }
    random = { source = "hashicorp/random", version = "= 3.9.1" }
  }

  # State holds generated passwords (encrypted at rest in S3). Configure it per environment:
  #   terraform init -backend-config="bucket=..." -backend-config="key=kerby/terraform.tfstate" \
  #     -backend-config="region=..." -backend-config="dynamodb_table=..." -backend-config="encrypt=true"
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "kerby", Environment = var.environment, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
