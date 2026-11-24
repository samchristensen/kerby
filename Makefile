SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup check typecheck lint format architecture docs knip test up down down-v psql logs logs-query e2e tools-e2e sdk-e2e sdk-build sdk-publish secrets-key worktree

# A worktree's .env (make worktree) names its compose project and published ports. Compose reads it by itself; the
# scripts behind e2e and logs-query read these from the environment, so export them.
-include .env
export KERBY_PROJECT KERBY_API_PORT KERBY_CONSOLE_PORT

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'


# worktree: a checkout under worktrees/<NAME> with its own compose project and ports, so stacks run side by side.
worktree: ## New git worktree for parallel work: make worktree NAME=<name> [BASE=main]; own branch, deps, compose project, ports
	@test -n "$(NAME)" || (echo "usage: make worktree NAME=<name> [BASE=main]" && exit 1)
	@echo "$(NAME)" | grep -Eq '^[a-z0-9][a-z0-9-]*$$' || (echo "NAME must be lowercase letters, digits and dashes" && exit 1)
	@dir=worktrees/$(NAME); test ! -e $$dir || (echo "$$dir already exists" && exit 1)
	git worktree add -b $(NAME) worktrees/$(NAME) $(or $(BASE),main)
	@cd worktrees/$(NAME) && pnpm install --frozen-lockfile && git config core.hooksPath .githooks
	@base=$$((20000 + $$(printf %s "$(NAME)" | cksum | cut -d' ' -f1) % 20000 * 2)) && \
	  printf 'KERBY_PROJECT=kerby-%s\nKERBY_API_PORT=%s\nKERBY_CONSOLE_PORT=%s\n' "$(NAME)" $$base $$((base + 1)) > worktrees/$(NAME)/.env && \
	  echo "" && echo "Worktree: worktrees/$(NAME) (branch $(NAME))" && \
	  echo "Stack: cd worktrees/$(NAME) && make up   (API :$$base, console :$$((base + 1)), project kerby-$(NAME))" && \
	  echo "Remove: make down-v inside it, then git worktree remove worktrees/$(NAME)"

setup: ## Install dependencies and git hooks
	pnpm install --frozen-lockfile
	git config core.hooksPath .githooks

check: typecheck lint architecture docs knip ## The gate: everything CI requires except tests. Run before saying done.

typecheck: ## tsc, strict: the repository, then the console's pages (JSX and the DOM, services/console/tsconfig.json)
	pnpm exec tsc
	pnpm exec tsc -p services/console

lint: ## Biome lint + format check
	pnpm exec biome check .

format: ## Biome auto-fix + format
	pnpm exec biome check --write .

architecture: ## Boundaries, layers, names, pinned deps, tenant-scoped tables (see ARCHITECTURE.md)
	node scripts/check-architecture.ts

docs: ## Every tracked .md: relative links resolve, named make targets and architecture rules exist
	node scripts/check-docs.ts

knip: ## Dead files, unused exports and types, unused or undeclared dependencies (knip.jsonc)
	pnpm exec knip

test: ## Run all tests
	pnpm exec vitest run

up: ## Build and start the local stack (one install: kerby and the console), print its API key and the console's address
	docker compose up -d --build --wait
	@key=$$(docker compose exec -T kerby printenv KERBY_API_KEY) && \
	  email=$$(docker compose exec -T kerby printenv KERBY_ADMIN_EMAIL) && \
	  echo "" && echo "Kerby is up. API: http://127.0.0.1:$${KERBY_API_PORT:-8080}" && echo "API key: $$key" && \
	  echo "Console: http://127.0.0.1:$${KERBY_CONSOLE_PORT:-3000} (sign in as $$email)"

down: ## Stop the local stack, keep its data
	docker compose down

down-v: ## Stop the local stack and delete its data, volumes and built images
	docker compose down --volumes --remove-orphans --rmi local

psql: ## psql into the control database (DB=<name> for another, e.g. a tenant database)
	docker compose exec postgres psql -U postgres $(or $(DB),kerby_control)

logs: ## Follow the stack logs
	docker compose logs -f --tail=100

logs-query: ## Filtered JSON log lines of the local stack: TENANT= LEVEL=warn MSG= SERVICE=api SINCE=30m UNTIL=
	@node scripts/logs.ts $(if $(TENANT),--tenant '$(TENANT)') $(if $(LEVEL),--level '$(LEVEL)') \
	  $(if $(MSG),--msg '$(MSG)') $(if $(SERVICE),--service '$(SERVICE)') $(if $(SINCE),--since '$(SINCE)') \
	  $(if $(UNTIL),--until '$(UNTIL)')

e2e: ## End to end on the real stack: two worker containers, kill one mid-turn, the turn finishes on the other (KERBY_E2E_KEEP=1 keeps the stack)
	node scripts/e2e.ts

tools-e2e: ## Tools on the real stack (ADR 0022): a local MCP server listed, granted to an integration without admin, called; drift pinned
	node scripts/tools-e2e.ts

sdk-e2e: ## @kerby/sdk against the running local stack (make up first): every resource called over HTTP, webhooks verified
	node scripts/sdk-e2e.ts

sdk-build: ## Build @kerby/sdk into packages/sdk/dist (compiled code, contracts, guide), as published
	node scripts/sdk.ts build

sdk-publish: ## Publish @kerby/sdk to its private GitHub repo as the next v<major>.<minor>.<n> if the build changed (CI does this on main; DRY=1 pushes nothing)
	node scripts/sdk.ts publish $(if $(DRY),--dry-run)

secrets-key: ## Make an install's secrets: KERBY_SECRET_KEY (every other key derives from it) and a KERBY_API_KEY
	node scripts/secrets-key.ts
