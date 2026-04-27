---
status: Ready for Implementation
created: 2026-04-27
updated: 2026-04-27
related_docs:
  - docs/plans/roadmap.md
  - docs/plans/phase-8-helm-charts.md
  - docs/plans/phase-9-local-k3s.md
  - docs/plans/phase-12-ec2-deployment.md
---

# Phase 11: CI/CD — Implementation Plan

## Context

All six services are built (Phases 1–10). Each has a Dockerfile, a Helm chart, and working local K3s deployment. The existing `.github/workflows/ci.yml` runs three quality jobs (typecheck, lint, test) on every push. Phase 11 wires the automation that takes a push to `main` all the way to a running EC2 cluster.

**What success looks like:**
- Every push on any branch runs four CI jobs: typecheck, lint, test, build (all six Docker images, no push). The build job runs only after the other three pass.
- Every time CI passes on `main`, `deploy.yml` triggers automatically: builds and pushes all six images to `ghcr.io`, then SSHes into EC2 and runs `helm upgrade` with the new image tag.
- A working EC2 instance (Phase 12) is not required to verify the CI half — the `ci.yml` build job passes independently.

---

## Scope

Three files to produce:

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | Extend — add `build` job |
| `.github/workflows/deploy.yml` | Create — build, push, deploy |
| `helm/vantage-demo/values-production.yaml` | Create — ghcr.io image repos for EC2 |

No changes to Dockerfiles, Helm chart templates, or application code.

---

## Design Decisions

### Why `workflow_run` trigger on `deploy.yml`?

`deploy.yml` triggers when `ci.yml` completes successfully on `main` — not directly on push. This is the key quality gate: broken code (failing typecheck, lint, or tests) causes `ci.yml` to fail, which means `deploy.yml` never fires. No branch protection rules or separate develop branch needed.

```yaml
on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]
```

The `build-and-push` job then adds a condition: `if: ${{ github.event.workflow_run.conclusion == 'success' }}`. A deploy attempt from a failed CI run is simply a no-op.

### Why separate `ci.yml` and `deploy.yml`?

A failing deploy (EC2 unreachable, helm timeout) should not register as a CI failure on the branch. Keeping them separate means deploy infrastructure problems don't block development feedback.

### Why `GITHUB_TOKEN` for ghcr.io?

GitHub Container Registry accepts the built-in `GITHUB_TOKEN` for image push when the workflow has `packages: write` permission. No personal access token or separate secret needed.

### Why a `values-production.yaml` file (not `--set` for repos)?

The image repository names (`ghcr.io/ApeOnFire/vantage-{service}`) are constant and not secrets. Committing them in `values-production.yaml` keeps the deploy command readable and the values auditable. Only `global.imageTag` is dynamic and passed via `--set`.

### Why tag with full SHA not short SHA?

Full SHA is unambiguous over the lifetime of a repo. GitHub Actions exposes it as `${{ github.sha }}`. Short SHA risks collision in long-lived repos. The tag format is `sha-${{ github.sha }}`.

### Why `--wait --timeout 10m` in helm upgrade?

For a demo with health checks on all pods, `--wait` ensures the workflow fails (not silently succeeds) if pods do not become Ready. Ten minutes is enough headroom for image pulls on a fresh EC2 start.

### Why `helm dependency build` instead of `helm dependency update`?

`Chart.lock` is committed with pinned versions and SHA256 digests for all dependencies. `helm dependency build` rebuilds `charts/` to match `Chart.lock` exactly without re-negotiating versions — the semantically correct choice for a reproducible deploy. `helm dependency update` re-resolves from `Chart.yaml` and regenerates `Chart.lock`, which is not what a deploy script should do.

Both commands require external repos to be registered via `helm repo add`. The deploy SSH command handles this with `helm repo add --force-update` before running `helm dependency build` — making the command fully self-contained and idempotent. `--force-update` (Helm ≥ 3.7) is a no-op if the repo is already registered with the same URL.

### Why `imagePullPolicy: IfNotPresent` (the default) in production?

The deploy uses immutable `sha-{sha}` tags. `IfNotPresent` means K3s pulls the image once and caches it locally — subsequent pod restarts do not hit the registry. `Always` would force a registry round-trip on every pod restart for zero benefit with immutable tags.

### Why `cache: 'pnpm'` is absent from the build job?

The `build` job uses Docker BuildKit. Docker handles its own dependency installation inside the build context. Adding pnpm cache setup to the build job would be dead weight.

---

## Implementation

### 1. Modify `.github/workflows/ci.yml`

Add a `build` job that runs after `typecheck`, `lint`, and `test`. It builds all six images via matrix using BuildKit but does not push. Uses `type=gha` cache to speed up repeated builds.

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  build:
    runs-on: ubuntu-latest
    needs: [typecheck, lint, test]
    strategy:
      fail-fast: false
      matrix:
        service:
          - alert-engine
          - ingestion-service
          - telemetry-simulator
          - event-store-service
          - api-service
          - dashboard
    steps:
      - uses: actions/checkout@v6

      - uses: docker/setup-buildx-action@v4

      - name: Build ${{ matrix.service }}
        uses: docker/build-push-action@v7
        with:
          context: .
          file: apps/${{ matrix.service }}/Dockerfile
          push: false
          tags: vantage/${{ matrix.service }}:ci
          cache-from: type=gha,scope=${{ matrix.service }}
          cache-to: type=gha,scope=${{ matrix.service }},mode=max
```

**Why `fail-fast: false`?** A failing dashboard build should not cancel an in-progress alert-engine build — each service's failure is independently informative.

**Why `needs: [typecheck, lint, test]`?** Docker builds are the most expensive step. No point spending build minutes on images from code that already fails quality checks.

### 2. Create `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

concurrency:
  group: deploy
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  build-and-push:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      fail-fast: false
      matrix:
        service:
          - alert-engine
          - ingestion-service
          - telemetry-simulator
          - event-store-service
          - api-service
          - dashboard
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - uses: docker/setup-buildx-action@v4

      - name: Log in to ghcr.io
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push ${{ matrix.service }}
        uses: docker/build-push-action@v7
        with:
          context: .
          file: apps/${{ matrix.service }}/Dockerfile
          push: true
          tags: |
            ghcr.io/${{ github.repository_owner }}/vantage-${{ matrix.service }}:sha-${{ github.event.workflow_run.head_sha }}
            ghcr.io/${{ github.repository_owner }}/vantage-${{ matrix.service }}:latest
          cache-from: type=gha,scope=${{ matrix.service }}
          cache-to: type=gha,scope=${{ matrix.service }},mode=max

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    steps:
      - name: Configure SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.EC2_SSH_KEY }}" > ~/.ssh/ec2-key
          chmod 600 ~/.ssh/ec2-key
          ssh-keyscan -H ${{ secrets.EC2_HOST }} >> ~/.ssh/known_hosts

      - name: Deploy to EC2
        run: |
          ssh -i ~/.ssh/ec2-key rocky@${{ secrets.EC2_HOST }} \
            "set -e && \
             cd /opt/vantage-demo && \
             git pull origin main && \
             helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update && \
             helm repo add grafana https://grafana.github.io/helm-charts --force-update && \
             helm repo update && \
             helm dependency build helm/vantage-demo && \
             helm upgrade --install vantage-demo helm/vantage-demo \
               --values helm/vantage-demo/values-production.yaml \
               --set global.imageTag=sha-${{ github.event.workflow_run.head_sha }} \
               --wait --timeout 10m"
```

**Notes for Implementation Claude:**

- The `workflow_run` event fires with the context of the triggering workflow, not the commit. Use `github.event.workflow_run.head_sha` (not `github.sha`) throughout — it points to the correct commit. `github.sha` in a `workflow_run` context is the HEAD of the default branch at the time the event fired, which may differ.
- `actions/checkout` in `build-and-push` uses `ref: ${{ github.event.workflow_run.head_sha }}` for the same reason.
- The `deploy` job has no `actions/checkout` — the runner never needs local repo files. It only SSHes to EC2 where the repo already lives.
- `rocky` is the default SSH user for Rocky Linux 9 AMI. Hardcoded here since Phase 12 specifies Rocky Linux 9.
- `ssh-keyscan` avoids the interactive host key prompt — acceptable for a demo.
- `concurrency: cancel-in-progress: true` means two rapid pushes to `main` cancel the earlier deploy run, preventing simultaneous `helm upgrade` calls.
- `helm repo add --force-update` requires Helm ≥ 3.7 (released Oct 2021). K3s on Rocky Linux 9 will be well above this. Both `helm repo add` calls are safe to run on every deploy — `--force-update` is a no-op when the repo URL is unchanged.

### 3. Create `helm/vantage-demo/values-production.yaml`

```yaml
# Production overrides for EC2 deployment.
# imagePullPolicy is intentionally omitted — values.yaml default (IfNotPresent)
# is correct for immutable sha-tagged images.

telemetry-simulator:
  image:
    repository: ghcr.io/ApeOnFire/vantage-telemetry-simulator

ingestion-service:
  image:
    repository: ghcr.io/ApeOnFire/vantage-ingestion-service

alert-engine:
  image:
    repository: ghcr.io/ApeOnFire/vantage-alert-engine

event-store-service:
  image:
    repository: ghcr.io/ApeOnFire/vantage-event-store-service

api-service:
  image:
    repository: ghcr.io/ApeOnFire/vantage-api-service

dashboard:
  image:
    repository: ghcr.io/ApeOnFire/vantage-dashboard
```

---

## GitHub Actions Secrets

Set these in **Settings → Secrets and variables → Actions → Secrets** on the GitHub repository:

| Secret | Value | Notes |
|--------|-------|-------|
| `EC2_SSH_KEY` | Full ED25519 private key content | Paste entire key including `-----BEGIN...` / `-----END...` lines |
| `EC2_HOST` | EC2 public IP or Elastic IP | Example: `1.2.3.4` |

`GITHUB_TOKEN` is automatic — no setup required.

**`EC2_SSH_KEY` generation (if not already done):**
```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/vantage-deploy
# Add ~/.ssh/vantage-deploy.pub to the EC2 authorized_keys
# Paste contents of ~/.ssh/vantage-deploy as the EC2_SSH_KEY secret
```

---

## ghcr.io Package Visibility

By default, packages pushed to `ghcr.io` are private. Package visibility is independent of repository visibility — making the repository public does **not** automatically publicise its packages.

After the first push, set each package public individually:
`https://github.com/ApeOnFire?tab=packages` → select package → **Package settings** → **Change visibility** → Public.

Repeat for all six packages: `vantage-alert-engine`, `vantage-ingestion-service`, `vantage-telemetry-simulator`, `vantage-event-store-service`, `vantage-api-service`, `vantage-dashboard`.

EC2 pulls images over HTTPS. Once packages are public, no registry authentication is needed on EC2.

---

## EC2 Prerequisites (for Phase 12 runbook)

One-time setup before the first automated deploy. `REPO_NAME` is determined in Phase 12.

```bash
# Clone the repository (repo is public by Phase 12)
git clone https://github.com/ApeOnFire/REPO_NAME /opt/vantage-demo
```

That is all. The deploy SSH command is fully self-contained: it runs `helm repo add --force-update` and `helm dependency build` on every deploy, so no separate chart setup is needed on EC2. `--force-update` (Helm ≥ 3.7) is a no-op if the repo is already registered.

---

## Success Criteria

**CI verification (no EC2 needed):**
1. Push to any non-main branch → all four `ci.yml` jobs (typecheck, lint, test, build×6) run green
2. Deliberately break a test → `ci.yml` fails → confirm `deploy.yml` does not trigger
3. Confirm `values-production.yaml` is committed with `ghcr.io/ApeOnFire/...` image repos

**Full deploy verification (requires Phase 12 EC2):**
4. Push to `main` → `ci.yml` passes → `deploy.yml` triggers via `workflow_run`
5. Six images appear at `ghcr.io/ApeOnFire/vantage-{service}:sha-{sha}` and `:latest`
6. Deploy job SSHes to EC2, `git pull` and `helm upgrade` complete with `--wait`
7. `kubectl get pods -A` on EC2 shows all pods Running with new image digests
8. Dashboard accessible, alarm flow end-to-end works
