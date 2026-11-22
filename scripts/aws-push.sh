#!/bin/sh
# Build the three production images for linux/amd64 (Fargate, X86_64) and push them to ECR, tagged with the git sha.
# Usage: AWS_REGION=eu-west-1 KERBY_ENVIRONMENT=production ./scripts/aws-push.sh
# Needs the AWS CLI with credentials, docker buildx, and the ECR repositories from infra/aws (terraform apply first).
set -eu
region="${AWS_REGION:?set AWS_REGION}"
environment="${KERBY_ENVIRONMENT:-production}"
account="$(aws sts get-caller-identity --query Account --output text)"
registry="$account.dkr.ecr.$region.amazonaws.com"
tag="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to push: the working tree is not clean, so the tag $tag would not describe the image" >&2
  exit 1
fi
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
for service in control api worker; do
  docker buildx build --platform linux/amd64 --target prod \
    -f "services/$service/Dockerfile" \
    -t "$registry/kerby/$environment/$service:$tag" --push .
done
echo "image_tag = \"$tag\""
