---
status: Draft
created: 2026-04-24
updated: 2026-04-25
related_docs:
  - docs/build-spec-vantage-demo.md
---

# Vantage Platform Demo — Build Roadmap

## Ordering Principles

The build order is driven by three constraints:

1. **Dependency direction**: shared types → core services → frontend → deployment scaffolding → ops
2. **Testability**: each phase can be mechanically verified before the next phase begins
3. **Safety-critical path first**: alert-engine (the alarm evaluator) is built before the services that call it, so its contracts are established before any caller is written

The system does not need to be end-to-end functional until Phase 7. Each phase produces something independently verifiable — a passing test suite, a healthy HTTP endpoint, data in a data store — but there is no requirement to wire everything together until the later phases.

---

## Phase Summary

| Phase | Name | Produces | Verify With |
|-------|------|----------|-------------|
| 1 | [Foundation](#phase-1-monorepo-foundation) | Monorepo, shared types, local infra, basic CI | `pnpm typecheck`, `docker compose up`, CI green |
| 2 | [alert-engine](#phase-2-alert-engine) | Alarm evaluator + DB + unit tests | `pnpm test`, manual POST /evaluate |
| 3 | [ingestion-service](#phase-3-ingestion-service) | Normalisation + routing + integration test | `pnpm test`, manual POST /events |
| 4 | [telemetry-simulator](#phase-4-telemetry-simulator) | Simulated device feed | Logs + alarm records in PG |
| 5 | [event-store-service](#phase-5-event-store-service) | Elasticsearch indexing pipeline | ES documents visible via curl |
| 6 | [api-service](#phase-6-api-service) | REST + WebSocket server | curl endpoints, wscat connection |
| 7 | [Angular dashboard](#phase-7-angular-dashboard) | C2 operator UI | Full end-to-end smoke test (local) |
| 8 | [Helm Charts](#phase-8-helm-charts) | Helm charts + Dockerfiles | `helm lint`, `docker build` |
| 9 | [Local K3s Deployment](#phase-9-local-k3s-deployment) | Full stack on local K3s | `kubectl get pods` all Running |
| 10 | [Observability](#phase-10-observability) | Prometheus + Grafana with live dashboards | Dashboards load with live data |
| 11 | [CI/CD](#phase-11-cicd) | Complete GitHub Actions pipelines | CI green + deploy.yml tested |
| 12 | [EC2 Deployment](#phase-12-ec2-deployment) | Live public URL | Full DoD checklist |

Each phase has its own detailed plan document in `docs/plans/`.

---

## Phase 1: Monorepo Foundation

**Plan:** [phase-1-foundation.md](phase-1-foundation.md)

**What gets built:**
- pnpm workspace root (`package.json`, `pnpm-workspace.yaml`)
- Shared TypeScript config (`tsconfig.json`, `tsconfig.base.json`)
- ESLint flat config (`eslint.config.mjs`)
- Vitest config (`vitest.config.ts`) with `passWithNoTests: true`
- `packages/types` — shared type definitions (`DetectionEvent`, `RadiationPayload`, `Heartbeat`, stub types)
- `docker-compose.yml` — PostgreSQL, Redis, Elasticsearch for local development
- `.env.example`, `.gitignore`
- **`.github/workflows/ci.yml`** — three parallel jobs: `typecheck`, `lint`, `test` (no Docker build yet)

**Why first:** everything downstream imports `@vantage/types`. The docker-compose local infrastructure is needed to run any service after Phase 1. The basic CI workflow gives a quality gate from the start; the `build` job is added in Phase 11 when Dockerfiles exist.

**Verify:** `pnpm install` → `pnpm typecheck` → `pnpm test` → `docker compose up -d && docker compose ps` (all healthy) → push to GitHub → CI runs green

---

## Phase 2: alert-engine

**Plan:** `docs/plans/phase-2-alert-engine.md`

**What gets built:**
- `apps/alert-engine/` service scaffolding
- Database migrations (`node-pg-migrate`): creates `alarm_rules`, `alarms` tables, seeds two radiation rules
- Pure `evaluate(event, rules)` function — takes `DetectionEvent` and rules array, returns `{ alarmTriggered, alarmSubtype }`. No database access, no network calls. This is the unit-testable core.
- `POST /evaluate` handler: calls `evaluate()`, then if `alarmTriggered`: writes alarm record to PG (gets `alarmId`), attempts HTTP POST to api-service `/internal/alarms/notify`. The api-service notification is **best-effort**: if api-service is unreachable, alert-engine logs a warning and still returns `{ alarmTriggered: true, alarmId, alarmSubtype }` to the caller. The alarm is written regardless.
- Rule hot-reload via PostgreSQL `LISTEN/NOTIFY` on `alarm_rules_updated` channel
- `GET /metrics` Prometheus endpoint (`alert_engine_evaluate_duration_seconds` histogram)
- Structured logging via `pino`
- **Unit tests** — all six cases from the spec's Testing section, testing `evaluate()` directly

**Why second:** alert-engine has no runtime dependencies on other services. Building it first establishes the alarm contract (`{ alarmTriggered, alarmId, alarmSubtype }`) before ingestion-service is written. The unit tests validate the safety-critical logic in isolation.

**Critical detail — `evaluate()` vs. handler split:**
- `evaluate(event, rules)` is pure: no DB, no network, no alarmId. Returns `{ alarmTriggered: boolean, alarmSubtype?: string }`.
- The `POST /evaluate` handler calls `evaluate()`, then performs the side effects (write to PG, notify api-service). The `alarmId` comes from the PG insert, not from `evaluate()`.
- Unit tests test `evaluate()` directly. The handler's database and notification behaviour are exercised by the running system (no separate unit test).

**Verify:** `pnpm test` (all six unit tests pass) → start alert-engine locally on port 3002 against docker-compose → `curl -X POST localhost:3002/evaluate` with a radiation payload → returns `{ alarmTriggered: true }` → confirm alarm record in PostgreSQL

---

## Phase 3: ingestion-service

**Plan:** `docs/plans/phase-3-ingestion-service.md`

**What gets built:**
- `apps/ingestion-service/` service scaffolding
- `POST /events` — validate, normalise, call alert-engine synchronously, enqueue to BullMQ
- `POST /heartbeats` — write device state to Redis with 30s TTL (fields: `lastSeen`, `backgroundCountRate`, `deviceType`, `status`)
- `GET /metrics` with `ingestion_events_total` counter labelled by `deviceId`, `eventType`, and `platformAlarmStatus`
- Structured logging with `traceId` propagation (header: `X-Trace-Id`)
- **Integration test** — alarm path ordering (three msw assertions from spec)

**Why third:** ingestion-service calls alert-engine synchronously. With alert-engine already defined, the integration test can mock that endpoint precisely. The BullMQ enqueue is spied on (no real Redis in tests).

**Verify:** `pnpm test` (integration test passes) → start ingestion-service (port 3001) + alert-engine (port 3002) locally → `curl -X POST localhost:3001/events` with a valid event → confirm alert-engine was called and job appears in BullMQ queue

---

## Phase 4: telemetry-simulator

**Plan:** `docs/plans/phase-4-telemetry-simulator.md`

**What gets built:**
- `apps/telemetry-simulator/` service (port 3000)
- Three simulated devices: `PM-01`, `PM-02` (PORTAL_MONITOR), `RIID-01` (RIID)
- Detection event loop: one event per device every ~15s, normally distributed background counts
- Heartbeat loop: every 5s per device (includes `deviceType` per the `Heartbeat` interface)
- `POST /scenario/:name` — injects alarm scenarios (`norm-threshold`, `isotope-identified`, `concurrent`)

**Note:** During this phase, alert-engine will attempt to notify api-service (which doesn't exist yet) after every alarm. Alert-engine's notification call is best-effort (established in Phase 2) — it will log a warning and proceed. This is expected and does not break Phase 4 verification.

**Why fourth:** by this point, ingestion-service and alert-engine are both running locally. Adding the simulator produces the first end-to-end data flow through three services.

**Verify:** start simulator + ingestion + alert-engine + infra → watch logs showing events dispatched → confirm alarm records appear in PostgreSQL → confirm Redis hash `device:state:PM-01` is present with a 30s TTL → trigger `POST /scenario/norm-threshold` → confirm alarm written within 2s

---

## Phase 5: event-store-service

**Plan:** `docs/plans/phase-5-event-store-service.md`

**What gets built:**
- `apps/event-store-service/` service (port 3003 — for `/metrics` only; no inbound HTTP beyond that)
- BullMQ worker consuming `detection-events` queue
- Elasticsearch index creation with explicit mapping on startup (keyword fields, date mapping, nested payload)
- Retry logic (3 attempts, exponential backoff)
- `GET /metrics` with `bullmq_queue_depth` gauge and `event_store_jobs_processed_total` counter

**Why fifth:** event-store-service only depends on Redis and Elasticsearch, both available since Phase 1.

**Verify:** start full stack (all 4 services + infra) → `curl localhost:9200/detection-events/_search` → confirm events are indexed with correct field types → trigger a scenario → event appears in Elasticsearch within a few seconds

---

## Phase 6: api-service

**Plan:** `docs/plans/phase-6-api-service.md`

**What gets built:**
- `apps/api-service/` service (port 3004)
- All REST endpoints:
  - `GET /api/alarms` — paginated alarm list
  - `GET /api/alarms/:id` — single alarm
  - `PATCH /api/alarms/:id/acknowledge`
  - `GET /api/events/search?q=&from=&to=&deviceId=&eventType=`
  - `GET /api/devices` — reads device state from Redis
  - `POST /api/scenarios/:name` — proxies to simulator `POST /scenario/:name`
- WebSocket server (`ws` package) — client registration + broadcast on alarm notify
- `POST /api/internal/alarms/notify` — called by alert-engine, broadcasts to WebSocket clients
- `GET /metrics`

**Why sixth:** api-service reads from all three data stores and proxies to the simulator. All dependencies exist after Phase 5.

**Verify:** start full stack → test each REST endpoint with curl → connect a WebSocket client (`wscat -c ws://localhost:3004/ws`) → trigger a scenario → alarm appears in WebSocket stream within 2s

---

## Phase 7: Angular Dashboard

**Plan:** `docs/plans/phase-7-angular-dashboard.md`

**What gets built:**
- `apps/dashboard/` — Angular 21 + PrimeNG 21 application
- Live Operations view (device status cards + active alarms + WebSocket)
- Detection Event Search view (Elasticsearch-backed full-text search)
- Alarm History view (paginated, filterable)
- Test Mode collapsible panel (three scenario buttons)
- Nginx config for serving the app in K3s (base href `/`)

**Why seventh:** Angular consumes api-service. With api-service fully functional, the dashboard can be developed and verified against the real running backend.

**Verify:** `ng serve` → open browser → Live Operations shows three device cards → trigger a scenario → alarm appears in Active Alarms within 2s without page refresh → acknowledge an alarm → it leaves the Active Alarms panel

---

## Phase 8: Helm Charts

**Plan:** `docs/plans/phase-8-helm-charts.md`

**What gets built:**
- Infrastructure sub-charts: `helm/charts/postgresql/`, `helm/charts/redis/`, `helm/charts/elasticsearch/`
  - Each: Deployment + Service + PersistentVolumeClaim + Secret
  - Elasticsearch chart includes all required env vars (security disabled, heap limited)
  - Elasticsearch Deployment includes an initContainer that sets `vm.max_map_count=262144` on the node before Elasticsearch starts — this is the standard K8s pattern for this requirement and works identically on Rancher Desktop and EC2 without host-level configuration:
    ```yaml
    initContainers:
      - name: sysctl
        image: busybox
        command: ['sh', '-c', 'sysctl -w vm.max_map_count=262144']
        securityContext:
          privileged: true  # required — sysctl is a kernel parameter
    ```
- Service charts: `helm/charts/` for all six services
  - Each: Deployment + Service, image tag from `{{ .Values.global.imageTag | default "latest" }}`
  - Per-service env vars from the umbrella's `values.yaml` using K8s DNS service names
- Umbrella chart: `helm/vantage-demo/`
  - `Chart.yaml`, `values.yaml` (site profile), `values-central.yaml` (central profile)
  - `_helpers.tpl`, nginx ingress with `/api/*` → api-service, `/` → dashboard, extended WebSocket timeouts
- Dockerfiles for all six services (node:22-alpine + tsx, monorepo root as build context)
  - Angular dashboard uses a multi-stage Dockerfile: `node:22-alpine` build stage → `nginx:alpine` serve stage

**Verify without a cluster:** `helm lint helm/vantage-demo` → `helm template helm/vantage-demo | kubectl apply --dry-run=client -f -` → `docker build` for each service succeeds. No cluster needed at this stage.

---

## Phase 9: Local K3s Deployment

**Plan:** `docs/plans/phase-9-local-k3s.md`

**What gets built:**
- Rancher Desktop configured as local K3s environment
- All service images built locally and made available to the K3s cluster
- Umbrella chart deployed via `helm install`

**Rancher Desktop setup:**
- Install Rancher Desktop on Windows; enable Kubernetes (K3s)
- Set container runtime to **containerd (nerdctl)** — Preferences → Container Engine → containerd. This uses the same runtime as K3s and as the production EC2 node, so images built locally are in the same store that K3s pulls from — no image transfer step needed.
- `kubectl`, `helm`, and `nerdctl` are all bundled; no separate installs needed
- Disable Traefik: Preferences → Kubernetes → uncheck "Enable Traefik". Do this before first cluster start, or disable and restart the cluster. Without this, port 80 is already claimed and the nginx-ingress install will conflict.

**vm.max_map_count:** handled by the initContainer in the Elasticsearch Helm chart (see Phase 8). No host-level sysctl configuration needed on Rancher Desktop or EC2.

**Local image strategy:** build images directly into K3s's containerd namespace using `nerdctl`, then deploy with an explicit imageTag override:
```bash
# Build each service directly into K3s's image store (run from repo root)
nerdctl --namespace k8s.io build -f apps/alert-engine/Dockerfile -t vantage/alert-engine:local .
# ... repeat for each service ...

# Deploy to local K3s — images are already in the right store
helm install vantage-demo helm/vantage-demo \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```
`--namespace k8s.io` targets K3s's containerd namespace directly, which is why `imagePullPolicy: Never` works without any image transfer step. The umbrella chart's deployment templates should honour `{{ .Values.global.imagePullPolicy | default "IfNotPresent" }}`.

**nerdctl vs docker:** `nerdctl` is a drop-in CLI replacement for `docker` against containerd. Commands are identical in form (`nerdctl build`, `nerdctl run`, `nerdctl ps`, etc.). For Phase 8 Dockerfile testing without a cluster, either `docker` (if Docker Desktop is also installed) or `nerdctl` without the `--namespace k8s.io` flag works fine — the namespace flag is only needed when targeting K3s.

**nginx-ingress:** install the nginx-ingress chart after Traefik is disabled, matching the production setup. Alternatively, use `kubectl port-forward` for local verification — simpler and sufficient.

**Verify:** `kubectl get pods -A` → all pods Running → access dashboard and API (via port-forward or ingress) → trigger a scenario → end-to-end alarm flow works in K3s

---

## Phase 10: Observability

**Plan:** `docs/plans/phase-10-observability.md`

**What gets built:**
- Prometheus chart (`prometheus-community/prometheus`) — static scrape config for all six services
- Grafana chart (`grafana/grafana`) — pre-provisioned via configmap, exposed at `/grafana`
- Three Grafana dashboard JSON files in `helm/vantage-demo/dashboards/`:
  - `alarm-path-health.json` — ingestion HTTP rate, `alert_engine_evaluate_duration_seconds` P50/P99
  - `indexing-path-health.json` — `bullmq_queue_depth`, `event_store_jobs_processed_total` rate
  - `device-activity.json` — events per minute per device, alarm count by subtype
- `helm/vantage-demo/templates/grafana-dashboards-configmap.yaml`

**Dashboard JSON is a manual step:** dashboards are built in the running Grafana UI with live data flowing, then exported via Dashboard → Share → Export → Save to file. The JSON files are committed to the repo and provisioned automatically on next deploy. Do not hand-author Grafana JSON. This step cannot be delegated to an automated implementation session — it requires a human interacting with the running Grafana UI.

An implementation agent assigned Phase 10 should: write all Helm chart scaffolding, the configmap template, and the provisioning configuration. Leave the three JSON files as empty stubs (`{}`). The JSON files are populated manually after the cluster is running with live data.

**Verify:** navigate to `/grafana` → all three dashboards load → trigger a scenario → `alert_engine_evaluate_duration_seconds` shows a spike → `bullmq_queue_depth` rises and falls

---

## Phase 11: CI/CD

**Plan:** `docs/plans/phase-11-cicd.md`

**What gets built:**
- Expansion of `.github/workflows/ci.yml` — adds `build` job (Docker builds for all six services) to the existing `typecheck`, `lint`, `test` jobs from Phase 1
- `.github/workflows/deploy.yml` — push to `main`: build → push to `ghcr.io` → SSH to EC2 → `helm upgrade`
- GitHub Actions secrets documented: `EC2_SSH_KEY`, `EC2_HOST`

**Note:** the `deploy.yml` workflow targets the EC2 instance that is provisioned in Phase 12. The `ci.yml` `build` job can be fully verified by pushing to GitHub before Phase 12. The `deploy.yml` is written in Phase 11 but not fully verified until Phase 12.

**Verify:** push to GitHub → all four CI jobs green → review deploy.yml for correctness (dry-run verification)

---

## Phase 12: EC2 Deployment

**Plan:** `docs/plans/phase-12-ec2-deployment.md`

**What gets built:**
- Provisioning runbook: `t3.xlarge`, Rocky Linux 9 AMI, K3s install (no host-level vm.max_map_count needed — handled by Elasticsearch initContainer)
- Elastic IP assignment, security group for ports 80/443/22
- cert-manager + Let's Encrypt (if time allows; HTTP-only is acceptable)
- GitHub repo made public, README written
- Verify `deploy.yml` completes successfully after adding EC2 secrets to GitHub

**Why last:** this phase is operations, not code. Everything runs on top of the deployed application.

**Verify:** DoD checklist (all items in spec §Definition of Done)

---

## Cross-Cutting Notes

**Package manager:** pnpm throughout. `pnpm-lock.yaml` committed. Dockerfiles use `pnpm install --frozen-lockfile`.

**TypeScript:** TypeScript 6.x, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, strict mode. `"type": "module"` in root `package.json` and all app/package `package.json` files. ESLint 9 (flat config). Vitest 4.x. TypeScript 6.0 changed the `types` default from wildcard-include-all to `[]` — `tsconfig.base.json` must include `"types": ["node"]` or `@types/node` globals stop resolving.

**Service runtimes:** all Node.js services use `tsx` (no compile step). `tsx` is installed as a devDependency in each service's `package.json`. Env vars are loaded via `tsx --env-file=../../.env src/index.ts` in local dev (Node native `--env-file` support). The `.env` at repo root is loaded by all services in local dev; Helm values.yaml provides env vars in K3s.

**Elasticsearch version:** docker-compose and Helm use `8.17.0`. Elasticsearch 9.x exists but was released ~3 months ago and introduces significant changes to security config defaults. Staying on 8.17.x is intentional for demo stability.

**Local service ports:**

| Service | Local Port |
|---------|-----------|
| telemetry-simulator | 3000 |
| ingestion-service | 3001 |
| alert-engine | 3002 |
| event-store-service | 3003 (metrics only) |
| api-service | 3004 |

**Inter-service URL env vars:**
- `ALERT_ENGINE_URL=http://localhost:3002` — used by ingestion-service
- `API_SERVICE_URL=http://localhost:3004` — used by alert-engine (best-effort notify)
- `INGESTION_SERVICE_URL=http://localhost:3001` — used by telemetry-simulator
- `TELEMETRY_SIMULATOR_URL=http://localhost:3000` — used by api-service (scenario proxy)

**traceId propagation:** ingestion-service generates a UUID `traceId` per inbound request and passes it as header `X-Trace-Id` to alert-engine. All services log `traceId` with every pino log line.

**alert-engine graceful degradation:** the HTTP POST to api-service on alarm is best-effort. If api-service is unreachable, alert-engine logs `warn` and continues. The alarm is written to PostgreSQL regardless. This behaviour is required from Phase 2 so that Phases 3–5 can run without api-service.

**Angular in the monorepo:** Angular's TypeScript config is managed by the Angular CLI — separate from the backend root `tsconfig.json`. `pnpm typecheck` covers backend services only; Angular type errors are caught by `ng build` in the CI `build` job (Phase 11). ESLint excludes `apps/dashboard/**`.

**Rancher Desktop (local K8s):** use Rancher Desktop with the **containerd (nerdctl)** backend on Windows. This provides K3s (matching production), kubectl, helm, and nerdctl. Images are built with `nerdctl --namespace k8s.io build`, tagged `local`, and deployed with `--set global.imageTag=local --set global.imagePullPolicy=Never`. Using containerd matches the production runtime from day one. See Phase 9 for full setup details.

**Plan documents:** each phase plan is written before implementation of that phase begins.
