SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup check typecheck lint format architecture test up down down-v psql logs

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
