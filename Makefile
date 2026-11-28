SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

.PHONY: help install check lint lint-code lint-docker lint-kubernetes format test test-api test-cruncher smoke-install smoke
.PHONY: init build up stop configure reload ps logs kube-build kube-up kube-configure kube-reload kube-forward

help:
	@printf '%s\n' \
	  'Checks' \
	  '  install                     Install the API and Cruncher dependencies' \
	  '  check                       Run lint, format, and tests after install' \
	  '  lint                        Check code, Dockerfiles, Compose, and Kustomize' \
	  '  format                      Check whitespace and conflict markers' \
	  '  test                        Run the API and Cruncher test suites' \
	  '  test-api / test-cruncher     Run one test suite' \
	  '  smoke-install               Install smoke test dependencies and Chromium' \
	  '  smoke                       Test a fresh running Docker stack (disposable only)' \
	  'Development' \
	  '  init                        Generate local configuration' \
	  '  build / up / stop           Build, start, or stop the Docker stack' \
	  '  configure / reload          Apply credentials or reload workflows in Docker' \
	  '  ps / logs                   Inspect Docker services (logs SERVICE=api)' \
	  '  kube-build / kube-up        Build Kubernetes images or apply manifests' \
	  '  kube-configure / kube-reload Apply credentials or reload workflows in Kubernetes' \
	  '  kube-forward                Forward Kubernetes services to local ports'

install:
	npm ci --prefix api --no-audit --no-fund
	npm ci --prefix cruncher --no-audit --no-fund

check: lint format test

lint: lint-code lint-docker lint-kubernetes

lint-code:
	git ls-files -z -- '*.mjs' | xargs -0 -r -n1 node --check
	for source in deploy/studio/*.ts; do \
		node --disable-warning=ExperimentalWarning -p \
			'require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$$source" \
			| node --input-type=module --check; \
	done
	bash -n hoverseer
	sh -n deploy/seed-workflows.sh

lint-docker:
	for dockerfile in deploy/images/*.Dockerfile; do \
		docker buildx build --check --build-arg BUILDKIT_DOCKERFILE_CHECK=error=true --file "$$dockerfile" .; \
	done
	POSTGRES_PASSWORD=checks-only BETTER_AUTH_SECRET=checks-only docker compose config --quiet
	POSTGRES_PASSWORD=checks-only BETTER_AUTH_SECRET=checks-only HOVERSEER_WORKSPACE_NAMESPACES='{}' docker compose -f compose.yaml -f compose.workspaces.yaml config --quiet
	POSTGRES_PASSWORD=checks-only BETTER_AUTH_SECRET=checks-only HOVERSEER_WORKSPACE_NAMESPACES='{}' INFISICAL_ENCRYPTION_KEY=checks-only INFISICAL_AUTH_SECRET=checks-only INFISICAL_DB_PASSWORD=checks-only docker compose -f compose.yaml -f compose.workspaces.yaml -f compose.infisical.yaml config --quiet
	POSTGRES_PASSWORD=checks-only BETTER_AUTH_SECRET=checks-only docker compose config --format json \
		| grep -q '"WORKFLOW_FILE": ""' # Zigflow must not load the image's default /app/workflow.yaml

lint-kubernetes:
	kubectl kustomize . | grep -A1 'name: WORKFLOW_FILE' | grep -q 'value: ""' # same Zigflow default as Compose

format:
	git diff --check "$$(git hash-object -t tree /dev/null)"

test: test-api test-cruncher

test-api:
	npm test --prefix api

test-cruncher:
	npm test --prefix cruncher

init:
	./hoverseer init

build:
	docker compose build

up stop configure reload:
	./hoverseer docker $@

ps:
	docker compose ps

logs:
	docker compose logs -f $(SERVICE)

kube-build kube-up kube-configure kube-reload kube-forward:
	./hoverseer kubernetes $(@:kube-%=%)

# Run only against a fresh, disposable local Compose stack. Creates test data.
smoke-install:
	npm ci --prefix api --no-audit --no-fund
	npm install --prefix api --no-save --package-lock=false --no-audit --no-fund playwright@1.56.1
	api/node_modules/.bin/playwright install --with-deps chromium

smoke:
	mkdir -p smoke-artifacts
	node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=smoke-artifacts/test-results.xml api/smoke.mjs
