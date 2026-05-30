# pdomain-index-npm — static npm registry tooling
# Usage: make <target>

.PHONY: help setup install typecheck lint lint-check format-check actionlint static-check pre-commit-check test build ci ci-slow publish-pkg rebuild-packuments sync-releases smoke

BASE_URL ?= https://pdomain.github.io/pdomain-index-npm/
ROOT ?= $(CURDIR)

help: ## Show this help message
	@echo "Available commands:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-22s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies from package-lock.json
	npm ci

install: setup ## Alias for setup

typecheck: ## Run TypeScript typecheck without emitting
	npm run typecheck

lint: ## Run ESLint
	npm run lint

lint-check: format-check lint ## Read-only format + lint checks

format-check: ## Check formatting without modifying files
	npm run format:check

actionlint: ## Lint GitHub Actions workflows
	npm run actionlint

static-check: ## Run typecheck, lint, format-check, and actionlint
	npm run static-check

pre-commit-check: static-check ## Run all read-only static checks

test: ## Run Node test suite
	npm test

build: ## Compile TypeScript to dist/
	npm run build

ci: ## Run complete CI pipeline (static-check, build, test)
	npm run ci

ci-slow: ci ## Full pre-flight for releases (alias of ci today)

publish-pkg: ## Publish a tarball into ROOT (set TARBALL=path or TARBALL_URL=url)
	@if [ -z "$(TARBALL)" ] && [ -z "$(TARBALL_URL)" ]; then \
		echo "ERROR: set TARBALL=path or TARBALL_URL=url"; \
		exit 2; \
	fi
	@if [ -n "$(TARBALL)" ]; then \
		npm run publish-pkg -- --tarball "$(TARBALL)" --root "$(ROOT)" --base-url "$(BASE_URL)"; \
	else \
		npm run publish-pkg -- --tarball-url "$(TARBALL_URL)" --root "$(ROOT)" --base-url "$(BASE_URL)"; \
	fi

rebuild-packuments: ## Rebuild packuments under ROOT
	npm run rebuild-packuments -- --root "$(ROOT)" --base-url "$(BASE_URL)"

sync-releases: ## Sync GitHub Release tarballs into ROOT
	npm run sync-releases -- --root "$(ROOT)" --base-url "$(BASE_URL)"

smoke: ## Run smoke helper
	npm run smoke
