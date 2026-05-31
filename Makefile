# pdomain-index-npm — static npm registry tooling
# Usage: make <target>

.PHONY: help setup install typecheck lint lint-check format-check actionlint shell-check static-check pre-commit-check test build ci ci-slow release-patch release-minor release-major _do-release regen-index smoke upgrade-deps

REGEN_ROOT ?= _site

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

shell-check: ## Check smoke shell script syntax
	npm run shell:check

static-check: ## Run typecheck, lint, format-check, actionlint, and shell syntax checks
	npm run static-check

pre-commit-check: static-check ## Run all read-only static checks

test: ## Run Node test suite
	npm test

build: ## Compile TypeScript to dist/
	npm run build

ci: ## Run complete CI pipeline (static-check and test)
	npm run ci

ci-slow: ci ## Full pre-flight for releases (alias of ci today)

release-patch: ## Release: bump patch, run ci-slow, tag, push (fires GitHub Release workflow; e.g. v0.1.0 -> v0.1.1)
	@$(MAKE) --no-print-directory _do-release BUMP=patch

release-minor: ## Release: bump minor, run ci-slow, tag, push (fires GitHub Release workflow; e.g. v0.1.0 -> v0.2.0)
	@$(MAKE) --no-print-directory _do-release BUMP=minor

release-major: ## Release: bump major, run ci-slow, tag, push (fires GitHub Release workflow; e.g. v0.1.0 -> v1.0.0)
	@$(MAKE) --no-print-directory _do-release BUMP=major

# scripts/do-release.sh handles repo-state guards, runs the ci-slow pre-flight,
# computes the next three-component tag from the latest v* tag, creates the
# annotated tag, and pushes main + tag to origin.
# Pass FORCE=1 to skip repo-state guards (pre-flight still runs).
# Pass SKIP_PUSH=1 to create the release commit/tag locally without pushing.
_do-release:
	@BUMP=$(or $(BUMP),minor) ./scripts/do-release.sh

regen-index: ## Regenerate the static registry into REGEN_ROOT without copying tarballs
	npm run regen-index -- --root "$(REGEN_ROOT)"

smoke: ## Run smoke helper
	npm run smoke

upgrade-deps: ## Upgrade npm dependencies
	npm update
