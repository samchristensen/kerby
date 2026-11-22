SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup check typecheck lint format architecture test up down down-v psql logs e2e multitenant infra aws-push

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

setup: ## Install dependencies and git hooks
	pnpm install --frozen-lockfile
	git config core.hooksPath .githooks

check: typecheck lint architecture ## The gate: everything CI requires except tests. Run before saying done.

typecheck: ## tsc, strict
	pnpm exec tsc

lint: ## Biome lint + format check
	pnpm exec biome check .

format: ## Biome auto-fix + format
	pnpm exec biome check --write .

architecture: ## Boundaries, layers, names, pinned deps, tenant-scoped tables (see ARCHITECTURE.md)
	node scripts/check-architecture.ts

test: ## Run all tests
	pnpm exec vitest run

up: ## Build and start the local stack, provision the default tenant, print its API key
	docker compose up -d --build --wait
	@key=$$(./scripts/provision-default.sh) && \
	  echo "" && echo "Kerby is up. API: http://127.0.0.1:$${KERBY_API_PORT:-8080}" && echo "API key (tenant default): $$key"

down: ## Stop the local stack, keep its data
	docker compose down

down-v: ## Stop the local stack and delete its data, volumes and built images
	docker compose down --volumes --remove-orphans --rmi local

psql: ## psql into the control database (DB=<name> for another, e.g. a tenant database)
	docker compose exec postgres psql -U postgres $(or $(DB),kerby_control)

logs: ## Follow the stack logs
	docker compose logs -f --tail=100

e2e: ## End to end on the real stack: kill a worker mid-turn, the turn finishes elsewhere (KERBY_E2E_KEEP=1 keeps the stack)
	node scripts/e2e.ts

multitenant: ## Cross-tenant attempts, suspension within the cache TTL, and a 200-tenant load run (KERBY_LOAD_TENANTS=n)
	node scripts/multitenant.ts

infra: ## Format-check and validate the Terraform in infra/aws (needs terraform; no AWS credentials)
	terraform -chdir=infra/aws fmt -check -recursive
	terraform -chdir=infra/aws init -backend=false -input=false >/dev/null
	terraform -chdir=infra/aws validate

aws-push: ## Build linux/amd64 images and push them to ECR (AWS_REGION=..., clean git tree)
	./scripts/aws-push.sh
