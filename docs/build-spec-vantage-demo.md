---
type: Spec
status: Draft
last_updated: 2026-04-24
last_validated: 2026-04-24
related_docs:
approx_tokens: 9200
---

# Vantage Platform Demo — Build Specification

## Context

This project exists to support a Principal Engineer interview process at a government border security technology company. The interviewers expressed concerns about Linux and microservices depth. The goal is to present a working demonstration that shows architectural understanding of their radiation detection C2 platform — built in a weekend, presented as "I inferred what your stack probably looks like and built it to test the inference."

The audience is the engineering team and hiring manager. This is not a portfolio piece — it is a targeted technical argument.

**What it must demonstrate:**
- Fluency with Kubernetes, Helm, and the operational decisions that come with containerised microservices
- Understanding of the architectural reasoning behind their stack — specifically: why the alarm path uses synchronous direct communication while the indexing path uses an async queue, and why these are different architectural choices for different reliability requirements
- Practical Linux competency (not sysadmin, but operational — installation, configuration, services running in production mode on a RHEL-family OS)
- Domain awareness — the app should look like a plausible C2 operator interface, not a developer demo

**What it does not need to be:**
- Production quality
- Secure (no auth, no TLS required beyond HTTPS on the public URL)
- Physically accurate (simulated scan data, no real spectral processing)

---

## Architecture Inference Summary

The Vantage Platform is inferred to be a microservices platform deployed on Kubernetes (evidenced by Helm in the job spec), with three data stores serving distinct access patterns: PostgreSQL for structured system-of-record data, Redis as backing store for job queues and device state cache, and Elasticsearch for the complete detection event history at query volume. The backend is confirmed TypeScript.

The platform is vendor-agnostic — it ingests data from first-party devices and from third-party sensors across multiple threat detection modalities (radiation, X-ray, and others). This makes the ingestion layer a **normalisation layer**: its job is to translate heterogeneous device-specific formats and protocols into a canonical internal schema. All downstream services consume only the canonical form.

The safety-critical alarm path is isolated as a separate service with its own failure domain, and communicates synchronously — not via a message broker — because the correct failure mode for alarm evaluation is loud and immediate, not silent queueing.

---

## Architecture Diagram

```mermaid
graph TD
    subgraph sim["Device Simulation"]
        SIM["telemetry-simulator"]
    end

    subgraph k8s["K3s Cluster · Rocky Linux 9"]
        subgraph svc["Services"]
            ING["ingestion-service"]
            ALERT["alert-engine"]
            EVT["event-store-service"]
            API["api-service + WebSocket"]
            ANG["Angular dashboard"]
        end
        subgraph infra["Infrastructure · Bitnami Helm Charts"]
            REDIS[("Redis · BullMQ + cache")]
            PG[("PostgreSQL")]
            ES[("Elasticsearch")]
        end
        INGRESS["nginx-ingress"]
    end

    SIM -->|HTTP POST detection event| ING
    ING -->|HTTP POST synchronous alarm path| ALERT
    ING -->|BullMQ enqueue async indexing| REDIS
    REDIS -->|BullMQ worker| EVT
    ALERT -->|write alarm record| PG
    ALERT -->|HTTP POST alarm notification| API
    EVT -->|index detection event| ES
    API -->|query alarms| PG
    API -->|search detection events| ES
    API -->|WebSocket push| ANG
    ANG -->|REST| API
    INGRESS --> API
    INGRESS --> ANG
```

---

## Event Model

The primary event is a **detection event** — a discrete summary generated when a device completes a scan of a subject (a vehicle passing through a portal monitor, a handheld RIID point-and-hold, a vehicle-mounted sweep). This is not a per-second sensor reading; it is a completed detection event.

The Vantage Platform ingests data from first-party devices and third-party sensors across multiple modalities. The canonical schema uses an **event envelope with a typed payload** — the envelope carries common routing and identity fields, the payload carries modality-specific data. Downstream services consume the envelope; modality-specific services narrow to the concrete payload type.

```typescript
// Envelope — common across all device types and vendors
interface DetectionEvent {
  eventId: string;           // UUID
  deviceId: string;          // e.g. "PM-01"
  deviceType: string;        // free string — spans modalities, e.g. "PORTAL_MONITOR", "XRAY_SCANNER"
  siteId: string;            // e.g. "POE-ALPHA"
  timestamp: string;         // ISO8601
  vendorId: string;          // e.g. "VANTAGE", third-party vendor identifier
  eventType: "RADIATION_SCAN" | "XRAY_SCAN" | "CBRN_DETECTION";
  alarmStatus: "CLEAR" | "ALARM";  // top-level — used for routing and dashboard filtering
  payload: RadiationPayload | XrayPayload | CbrnPayload;
}

// Radiation-specific payload — the only type implemented in this demo
interface RadiationPayload {
  type: "RADIATION_SCAN";
  durationMs: number;
  peakCountRate: number;       // cps
  backgroundCountRate: number;
  isotope: string | null;      // null = no identification
  alarmSubtype: "NORM_THRESHOLD" | "ISOTOPE_IDENTIFIED" | null;
}

// Stub types — not implemented; present to make the pattern legible
interface XrayPayload { type: "XRAY_SCAN"; [key: string]: unknown; }
interface CbrnPayload { type: "CBRN_DETECTION"; [key: string]: unknown; }
```

The demo only implements `RadiationPayload`. The envelope structure makes the extensibility legible without requiring X-ray or CBRN pipelines to be built. The README names this explicitly.

The simulator also emits a lightweight **heartbeat** every 5 seconds per device (`deviceId`, `timestamp`, `backgroundCountRate`, `status: "ONLINE"`). This is not stored in Elasticsearch — it updates Redis device state only.

**Simulator cadence:** one detection event per device every ~15 seconds (configurable), simulating moderate vehicle throughput. Background `peakCountRate` normally distributed around 45 cps with σ=8. Injected alarm scenarios override this — see Test Mode.

---

## Services

All services are TypeScript. Use a monorepo structure (`apps/`) with a shared `packages/types` package exporting `DetectionEvent`, `RadiationPayload`, `Heartbeat`, and the stub payload types. Each service is its own Docker image.

**Cross-cutting: Docker runtime.** All service images use `node:20-alpine` as the base image and run via `tsx` — no compile step. This simplifies Dockerfiles and is appropriate for a demo. Each service's Dockerfile is built with the repo root as the build context (required for access to `packages/types`): copy `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/`, and the specific `apps/{service}/` directory, run `pnpm install --frozen-lockfile`, then `CMD ["pnpm", "tsx", "src/index.ts"]`.

**Cross-cutting: package manager.** Use pnpm workspaces. `pnpm-workspace.yaml` lists `apps/*` and `packages/*`. All `tsc --noEmit` and lint commands run from the repo root via workspace scripts.

**Cross-cutting: WebSocket.** Use the `ws` package for the WebSocket server in api-service. Do not use Socket.io — it adds socket-level protocol overhead and connection fallbacks that are unnecessary here.

**Cross-cutting: service discovery.** Inter-service URLs are passed as environment variables, not hardcoded. Each Helm chart defines its own `env:` block; the umbrella chart's `values.yaml` wires them together using Kubernetes DNS service names. Example: ingestion-service receives `ALERT_ENGINE_URL=http://alert-engine` and `API_SERVICE_URL=http://api-service`. alert-engine receives `API_SERVICE_URL=http://api-service`. Services communicate on their default port (3000 unless specified). No service mesh or service discovery library required — standard K8s DNS handles this.

**Cross-cutting: database migrations.** alert-engine owns the PostgreSQL schema (it is the only service that writes to `alarm_rules` and `alarms`). api-service reads from both tables. alert-engine runs migrations on startup using `node-pg-migrate` (or equivalent); migration files live in `apps/alert-engine/migrations/`. Migrations must be idempotent. The single migration file creates `alarm_rules`, `alarms`, and seeds the two default radiation rules.

**Cross-cutting: structured logging.** All services use `pino` for structured JSON to stdout. Every log line includes `service`, `timestamp`, and `traceId` (a UUID generated per inbound request at ingestion-service and passed as an HTTP header to downstream services). K3s captures stdout; `kubectl logs` makes it queryable.

**Cross-cutting: Prometheus metrics.** All services expose `GET /metrics` via `prom-client`. Standard instrumentation per service: HTTP request count and latency histogram labelled by route and status code. Additional per-service metrics are specified below where relevant.

### telemetry-simulator

Simulates three named devices: `PM-01`, `PM-02` (portal monitors, `deviceType: "PORTAL_MONITOR"`), `RIID-01` (handheld, `deviceType: "RIID"`). Site: `POE-ALPHA`. Vendor: `VANTAGE`. All emit `eventType: "RADIATION_SCAN"` with `RadiationPayload`.

Emits `DetectionEvent` objects to `ingestion-service POST /events` at a configurable interval. Emits heartbeats to `ingestion-service POST /heartbeats` every 5 seconds.

Exposes `POST /scenario/:name` for Test Mode injection (see below). Runs as an in-cluster Deployment.

### ingestion-service

The normalisation layer. Receives two endpoints:

`POST /events` — validates payload against the `DetectionEvent` envelope schema, normalises (timestamps to ISO8601, device IDs to uppercase), then processes in sequence:
1. **Alarm path (synchronous):** HTTP POST to `alert-engine POST /evaluate`. Waits for response. alert-engine returns `{ alarmTriggered, alarmId }`. ingestion-service sets `alarmStatus` on the event accordingly. If alert-engine is unreachable or returns 5xx, ingestion returns 503 — the failure is immediate and visible.
2. **Indexing path (async):** Enqueues the enriched `DetectionEvent` (with `alarmStatus` set) as a BullMQ job to the `detection-events` queue (Redis-backed). Returns 202 immediately — does not wait for Elasticsearch indexing to complete.

The two paths are sequentially ordered (alarm eval before enqueue) but **failure-independent**: a BullMQ or Elasticsearch failure after step 1 does not cause step 1 to be retried or to fail.

`POST /heartbeats` — writes device state to Redis hash `device:state:{deviceId}` (last-seen, background count rate, online status) with a **TTL of 30 seconds**. If no heartbeat arrives within 30s, the key expires. `GET /api/devices` returns `status: "OFFLINE"` for any device whose key is absent. This is the device offline detection mechanism — no explicit "go offline" message is needed.

No persistence of its own. No alarm logic. Its only job is normalisation and routing.

Additional Prometheus metric: `ingestion_events_total` counter labelled by `deviceId`, `eventType`, and `alarmStatus` (populated after alert-engine responds). This is the source metric for the Device Activity Grafana dashboard.

### alert-engine

Exposes `POST /evaluate` — receives a `DetectionEvent`, narrows the payload by `eventType`, evaluates against applicable alarm rules, returns result synchronously.

Alarm rules are stored in PostgreSQL `alarm_rules` table with an `eventType` column scoping each rule to a modality. Rules are loaded at startup and cached in-process. Rule changes are detected via a PostgreSQL `LISTEN/NOTIFY` channel (`alarm_rules_updated`) — the service re-queries the table on notification without restarting. This is the hot-reload mechanism.

**Rule evaluation:** filter rules to those matching the event's `eventType`, then evaluate in `id` order. **First matching rule wins** — one alarm record per event, one `alarmSubtype` returned. Evaluation stops at the first match. This simplification is intentional and must be reflected in the migration's seed data ordering (NORM_THRESHOLD seeded before ISOTOPE_IDENTIFIED).

`alarm_rules` table schema:
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` default |
| `event_type` | `TEXT NOT NULL` | e.g. `'RADIATION_SCAN'` |
| `field` | `TEXT NOT NULL` | e.g. `'peakCountRate'`, `'isotope'` |
| `operator` | `TEXT NOT NULL` | `'>'` or `'IS NOT NULL'` |
| `threshold` | `NUMERIC` | `NULL` for `IS NOT NULL` operators |
| `alarm_subtype` | `TEXT NOT NULL` | e.g. `'NORM_THRESHOLD'` |
| `enabled` | `BOOLEAN NOT NULL` | `DEFAULT TRUE` |

`alarms` table schema:
| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` default |
| `device_id` | `TEXT NOT NULL` | |
| `site_id` | `TEXT NOT NULL` | |
| `event_type` | `TEXT NOT NULL` | |
| `alarm_subtype` | `TEXT NOT NULL` | |
| `peak_count_rate` | `NUMERIC` | `NULL` for non-radiation events |
| `isotope` | `TEXT` | `NULL` if not identified |
| `status` | `TEXT NOT NULL` | `'ACTIVE'` or `'ACKNOWLEDGED'`; `DEFAULT 'ACTIVE'` |
| `triggered_at` | `TIMESTAMPTZ NOT NULL` | from the event's `timestamp` field |
| `acknowledged_at` | `TIMESTAMPTZ` | `NULL` until acknowledged |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT NOW()` |

On alarm condition:
- Writes alarm record to `alarms` table
- HTTP POSTs the alarm record to `api-service POST /internal/alarms/notify` (api-service broadcasts to WebSocket clients)
- Returns `{ alarmTriggered: true, alarmId, alarmSubtype }` to ingestion-service, which sets `alarmStatus: "ALARM"` on the event before enqueuing to BullMQ

On clear:
- Returns `{ alarmTriggered: false }` — no writes

Alarm rules (seed data, `eventType: "RADIATION_SCAN"`):
- `field: "peakCountRate"`, `operator: ">"`, `threshold: 250` → `alarmSubtype: "NORM_THRESHOLD"`
- `field: "isotope"`, `operator: "IS NOT NULL"` → `alarmSubtype: "ISOTOPE_IDENTIFIED"`

This service has no Redis dependency, no Elasticsearch dependency. If the indexing pipeline falls over entirely, alarm evaluation is unaffected.

Additional Prometheus metric: `alert_engine_evaluate_duration_seconds` histogram. This is the single most important custom metric in the system — it makes the alarm path's latency directly observable and is what you'd alert on in production (P99 > threshold).

### event-store-service

BullMQ worker consuming the `detection-events` queue. For each job: indexes the `DetectionEvent` (envelope + payload) to Elasticsearch index `detection-events`. Configured with retry (3 attempts, exponential backoff) — if Elasticsearch is briefly unavailable, jobs retry rather than vanish.

Every detection event is indexed regardless of alarm status. The reasons: government audit requirements (prove every subject was scanned), background baseline analysis, compliance reporting. The Elasticsearch index holds the complete operational record, not just exceptions. The envelope's `eventType` field allows filtered queries per modality; the `payload` object is stored as a nested document.

**Index mapping:** define an explicit mapping for the `detection-events` index before indexing begins. Without it, Elasticsearch dynamic mapping will infer `deviceId`, `eventType`, `alarmStatus`, and `siteId` as `text` (full-text analysed), breaking term filter queries in the search endpoint. These fields must be mapped as `keyword`. `timestamp` must be mapped as `date`. `peakCountRate` and `backgroundCountRate` as `float`. The `payload` object should be mapped as a nested type. Create the index with explicit mappings on event-store-service startup if it does not already exist.

Additional Prometheus metrics: `bullmq_queue_depth` gauge (current job count in the `detection-events` queue), `event_store_jobs_processed_total` counter. Queue depth is the key health signal for the indexing path — a growing queue means Elasticsearch is falling behind.

### api-service

Exposes REST endpoints and a WebSocket connection consumed by the Angular dashboard.

All routes are prefixed `/api/` to match ingress routing.

REST:
- `GET /api/alarms` — paginated alarm list from PostgreSQL
- `GET /api/alarms/:id` — single alarm
- `PATCH /api/alarms/:id/acknowledge` — updates status in PostgreSQL
- `GET /api/events/search?q=&from=&to=&deviceId=&eventType=` — proxies to Elasticsearch `detection-events` index
- `GET /api/devices` — reads device state from Redis (`device:state:*` keys)
- `POST /api/scenarios/:name` — proxies to telemetry-simulator `POST /scenario/:name`; exposes the test mode trigger through a single ingress-accessible endpoint
- `POST /api/internal/alarms/notify` — called by alert-engine (internal, in-cluster); pushes alarm payload to connected WebSocket clients

WebSocket: on client connection, registers the client for alarm push notifications. When `/internal/alarms/notify` is called, the alarm is broadcast to all connected clients immediately.

### Angular dashboard

See Dashboard Specification below.

---

## Infrastructure

All three data stores deployed as simple Helm sub-charts in `helm/charts/` using official upstream images. The Bitnami Helm charts previously used for this pattern moved behind a Broadcom subscription in September 2025 and are no longer viable. Elastic's official standalone Helm charts were archived after v8.5.1 (Elastic now recommends their ECK operator, which is overkill for a single-node demo). The approach here — simple sub-charts with official images — avoids any external chart repository dependency and is appropriate for a demo targeting an air-gapped deployment model.

Each infrastructure sub-chart contains: a Deployment, a Service, a PersistentVolumeClaim, and a Secret for credentials. No operators.

| Store | Image | Role |
|---|---|---|
| PostgreSQL | `postgres:16-alpine` | Alarm records, alarm rules (with LISTEN/NOTIFY), device registry |
| Redis | `redis:7-alpine` | BullMQ job queue backing store, device state cache |
| Elasticsearch | `docker.elastic.co/elasticsearch/elasticsearch:8.17.0` | Complete detection event history, operator search |

**Elasticsearch configuration:** Elasticsearch 8.x enables TLS and authentication by default. The Elasticsearch sub-chart Deployment must set all four of these env vars — missing any one causes silent connection failures:
```yaml
- name: discovery.type
  value: single-node
- name: xpack.security.enabled
  value: "false"
- name: xpack.security.http.ssl.enabled
  value: "false"
- name: xpack.security.enrollment.enabled
  value: "false"
- name: ES_JAVA_OPTS
  value: "-Xms1g -Xmx1g"
```
The `ES_JAVA_OPTS` heap limit is also required — without it, Elasticsearch auto-detects available memory and may claim most of the 16GB on the t3.xlarge, starving the other services.

Nginx ingress via `ingress-nginx/ingress-nginx` chart. Routes `/api/*` to api-service (all api-service routes are prefixed `/api/` — see api-service spec); `/` to Angular dashboard. All api-service route definitions must include the `/api` prefix accordingly.

**WebSocket through ingress:** ingress-nginx handles WebSocket upgrade headers automatically — no `configuration-snippet` required (and it is disabled by default since ingress-nginx v1.9 for security reasons). The only required annotations on the `/api/*` rule are the timeout extensions:
```yaml
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```
Without the extended timeouts, idle WebSocket connections will be terminated after the default 60-second proxy timeout.

---

## Observability Stack

Deployed as two additional Helm charts — **not** `kube-prometheus-stack`, which is too resource-heavy for a single-node demo. Install Prometheus server and Grafana separately:

| Component | Chart | Notes |
|---|---|---|
| Prometheus | `prometheus-community/prometheus` | Scrapes `/metrics` from all six services via static scrape config in `values.yaml`. No operator, no Alertmanager. |
| Grafana | `grafana/grafana` | Three dashboards (see below). Exposed via ingress at `/grafana`. Pre-provisioned via Grafana's configmap-based dashboard provisioning — dashboards are JSON files in the chart, not manually built at runtime. |

Ingress addition: `/grafana` → Grafana service (alongside `/api/*` → api-service and `/` → Angular dashboard).

### Grafana dashboards

All three are provisioned as JSON configmaps — they exist in the repo and load automatically on Grafana startup.

**Workflow for creating dashboard JSON:** Build each dashboard in the running Grafana UI first (with live data flowing), then export via Dashboard → Share → Export → Save to file. Commit the exported JSON to `helm/vantage-demo/dashboards/`. Do not attempt to hand-author Grafana JSON. Build order: get all services running and data flowing first; build dashboards last.

**Alarm Path Health**
- ingestion-service HTTP request rate and 5xx rate
- `alert_engine_evaluate_duration_seconds` P50 and P99
Purpose: makes the alarm path's health directly observable. The P99 latency panel is what you'd set an alert threshold on in production.

**Indexing Path Health**
- `bullmq_queue_depth` for the `detection-events` queue
- `event_store_jobs_processed_total` rate
Purpose: queue depth growing = Elasticsearch falling behind. This is the observable expression of the async path's behaviour — and visually demonstrates that the indexing path is independent of the alarm path.

**Device Activity**
- Detection events per minute per device (from ingestion-service request metrics, labelled by `deviceId`)
- Alarm count over time by `alarmSubtype`
Purpose: makes the system feel live; contextualises what operators would actually watch.

---

## Helm Chart Structure

```
helm/
  charts/
    telemetry-simulator/
    ingestion-service/
    alert-engine/
    event-store-service/
    api-service/
    dashboard/
    postgresql/             ← simple sub-chart: Deployment + Service + PVC + Secret
    redis/                  ← simple sub-chart: Deployment + Service + PVC + Secret
    elasticsearch/          ← simple sub-chart: Deployment + Service + PVC + Secret
  vantage-demo/           ← umbrella chart
    Chart.yaml
    values.yaml             ← site deployment profile (full stack)
    values-central.yaml     ← central management profile
    dashboards/             ← Grafana dashboard JSON files (provisioned via configmap)
      alarm-path-health.json
      indexing-path-health.json
      device-activity.json
    templates/
      _helpers.tpl
      grafana-dashboards-configmap.yaml
```

**Site profile** (`values.yaml`): full stack — all six services, all three data stores, Prometheus, Grafana. Represents a border installation running the complete local platform.

**Central profile** (`values-central.yaml`): disables telemetry-simulator, ingestion-service, alert-engine, event-store-service. Runs API + dashboard + Elasticsearch only. Represents a hub aggregating data across multiple sites. Implement as `ingestionEnabled: true/false` in values.

---

## Angular Dashboard Specification

Must read as a plausible C2 operator interface. Use domain-appropriate language throughout. **Angular 21, PrimeNG 21.** PrimeNG versions track Angular versions directly — use matching major versions. PrimeNG 21 uses standalone components; do not use NgModule-based imports.

### Views

**Live Operations (default view)**
- Device status panel: three cards (`PM-01`, `PM-02`, `RIID-01`). Each card: device type label, last scan timestamp, last background count rate, online/offline status. Updated via `GET /api/devices` polled every 10 seconds.
- Active alarms panel: real-time list of unacknowledged alarms, updated via WebSocket. Each row: alarm type badge, device ID, timestamp, peak count rate, isotope (if identified), Acknowledge button. New alarms animate in without page refresh.
- Site header: "POE-ALPHA · 3 devices online"

**Detection Event Search**
- Date range picker, device filter dropdown, event type filter, free-text field
- Results table: timestamp, device ID, event type, peak count rate, isotope (if radiation), alarm status badge
- Backed by `GET /api/events/search` → Elasticsearch `detection-events` index
- This view demonstrates the audit trail argument: every detection event is here, not just alarms

**Alarm History**
- Paginated table of all alarms (acknowledged and active), newest first
- Filter by type, device, date range, status
- Backed by `GET /api/alarms`

### Test Mode Panel

Collapsible side panel labelled "Test Mode — Scenario Simulation." Real C2 systems have training modes for operator exercises; this framing is intentional.

| Button | What it triggers |
|---|---|
| NORM Threshold Exceedance | `POST /api/scenarios/norm-threshold` → api-service proxies to simulator → emits detection event with `peakCountRate: 320` from `PM-01` |
| Isotope Identification | `POST /api/scenarios/isotope-identified` → api-service proxies to simulator → emits detection event with `isotope: "Cs-137"`, `peakCountRate: 180` from `PM-02` |
| Concurrent Alarms | `POST /api/scenarios/concurrent` → api-service proxies to simulator → fires both simultaneously from `PM-01` and `PM-02` |

Angular calls `POST /api/scenarios/:name` on api-service, which proxies to the simulator's in-cluster `POST /scenario/:name` endpoint. The simulator is not directly exposed through the ingress. The goal is to make the full alarm path visible in real time on the dashboard within 1–2 seconds of the button press.

---

## Testing

**Framework:** Vitest throughout — TypeScript-native, zero config, fast.

### alert-engine — rule evaluation unit tests

The alarm evaluation logic is the safety-critical path and must have deterministic unit tests. Structure the evaluator as a pure function: takes a `DetectionEvent` and an array of `alarm_rules` objects, returns `{ alarmTriggered, alarmSubtype }`. No database call, no network. Tests run in milliseconds with no infrastructure.

Minimum test cases:
- `peakCountRate: 320`, rule `peakCountRate > 250` → `{ alarmTriggered: true, alarmSubtype: "NORM_THRESHOLD" }`
- `peakCountRate: 100`, same rule → `{ alarmTriggered: false }`
- `isotope: "Cs-137"`, rule `isotope IS NOT NULL` → `{ alarmTriggered: true, alarmSubtype: "ISOTOPE_IDENTIFIED" }`
- `isotope: null`, same rule → `{ alarmTriggered: false }`
- `eventType: "XRAY_SCAN"` against radiation-scoped rules → `{ alarmTriggered: false }` (rules are filtered by `eventType` before evaluation — this tests scoping)
- First matching rule wins; no second alarm record written for a single event

The database-interaction layer (loading rules from PostgreSQL, writing alarm records) is exercised by the running system during DoD verification — not unit tested.

### ingestion-service — alarm path ordering test

One integration test verifying the sequential contract: alert-engine must be called synchronously and `alarmStatus` must be set from its response before the BullMQ enqueue.

Use **msw** (`msw/node`) to intercept the HTTP call to alert-engine. Do not use nock — nock operates at the Node.js `http` module level and does not intercept native `fetch` (available since Node 18), which is what services in this project should use. msw v2 intercepts at the network level and works correctly with native fetch. Set up the server in Vitest's `beforeAll`/`afterAll` hooks.

```typescript
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const server = setupServer()
beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

Spy on the BullMQ enqueue call (no real Redis required). Assert:
1. When alert-engine returns `{ alarmTriggered: true, alarmSubtype: "NORM_THRESHOLD" }`, the enqueued job payload contains `alarmStatus: "ALARM"`
2. When alert-engine returns `{ alarmTriggered: false }`, the enqueued job payload contains `alarmStatus: "CLEAR"`
3. If alert-engine returns 503, ingestion returns 503 and BullMQ enqueue is not called

**What is not unit-tested:** event-store-service (thin wrapper around BullMQ and Elasticsearch — not worth the infrastructure overhead), api-service routes (exercised via the live system in DoD verification), Angular (verified visually in the Loom recording).

---

## CI/CD

**Platform:** GitHub Actions. Free for public repos, native integration with GitHub Container Registry (`ghcr.io`), no additional infrastructure.

### Workflow: ci.yml

Triggers on every push and pull request to any branch.

Jobs (parallel):
1. **typecheck** — `tsc --noEmit` at monorepo root, covering all apps and the shared `packages/types` package via project references
2. **lint** — ESLint across all apps
3. **test** — Vitest; runs alert-engine unit tests and ingestion-service alarm path test; no external services required
4. **build** — `docker build` for each service image (verifies images build cleanly; does not push)

### Workflow: deploy.yml

Triggers on push to `main` only.

Steps:
1. Build all service Docker images
2. Push to `ghcr.io/{owner}/{repo}/{service}:{git-sha}` using `GITHUB_TOKEN` (no separate registry credentials needed for a public repo)
3. SSH to EC2 and run:
```bash
helm upgrade vantage-demo helm/vantage-demo \
  --set global.imageTag=${{ github.sha }}
```

**Helm chart requirement:** every service chart's Deployment template uses `{{ .Values.global.imageTag | default "latest" }}` as the image tag. The umbrella `values.yaml` includes `global.imageTag: latest` as the default for local development. CI overrides this at deploy time with the git SHA, giving a full audit trail of what is running on the EC2 instance.

**Secrets required:** `EC2_SSH_KEY` (private key for EC2 instance access), `EC2_HOST` (Elastic IP). Both stored as GitHub Actions repository secrets.

---

## Delivery Target

- **Runtime:** Single EC2 instance, `t3.xlarge` (4 vCPU, 16GB RAM), Rocky Linux 9 AMI. Upgrade from t3.large is necessary: Elasticsearch alone requires ~2GB heap; Prometheus adds ~512MB; headroom matters for a live demo.
- **K3s:** Installed via the official install script, single-node
- **Public access:** Elastic IP. HTTPS via Let's Encrypt + cert-manager if time allows; HTTP-only is acceptable.
- **GitHub repo:** Public, clean history, MIT licence
- **README:** See the accompanying presentation strategy document

---

## Local Development

For daily code iteration, run the three infrastructure stores via Docker Compose and the Node.js services natively (e.g. `tsx watch`). Do not use K3s for inner-loop development — the image build and deploy cycle is too slow.

`docker-compose.yml` at the repo root:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: vantage
      POSTGRES_PASSWORD: vantage
      POSTGRES_DB: vantage
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vantage"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.17.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - xpack.security.http.ssl.enabled=false
      - xpack.security.enrollment.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health | grep -v '\"status\":\"red\"'"]
      interval: 10s
      timeout: 10s
      retries: 12

volumes:
  postgres-data:
  elasticsearch-data:
```

Redis has no volume — BullMQ job loss on restart is acceptable in local dev.

**WSL2 prerequisite:** Elasticsearch requires `vm.max_map_count=262144` or it will exit immediately with a bootstrap check failure. Set it for the current session:
```bash
sudo sysctl -w vm.max_map_count=262144
```
To make it permanent inside WSL2, add `vm.max_map_count=262144` to `/etc/sysctl.d/99-elasticsearch.conf`.

**Local service environment variables** (`.env` at repo root, gitignored):
```
DATABASE_URL=postgresql://vantage:vantage@localhost:5432/vantage
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200
```
Inter-service URLs (e.g. `ALERT_ENGINE_URL`) point to `localhost` with whatever port each service binds on locally. The Helm `values.yaml` env vars are for the K3s deployment only.

---

## Explicit Scope Decisions

| Decision | Rationale |
|---|---|
| K3s not full K8s | Same Helm/kubectl primitives; appropriate for single-node demo; more realistic for edge deployments than minikube |
| Rocky Linux 9 not Ubuntu | RHEL-family signals awareness of their likely OS choice for air-gapped government deployments |
| Direct HTTP on alarm path, not broker | Alarm evaluation must fail loudly if alert-engine is unavailable. Silent queueing is the wrong failure mode for a safety-critical path. K8s replicas handle HA at the service level. |
| BullMQ on indexing path | Detection event indexing tolerates latency and benefits from retry. BullMQ is idiomatic TypeScript, Redis-backed (no new dependency), and separates indexing reliability from alarm reliability. |
| PostgreSQL LISTEN/NOTIFY for rule hot-reload | Alarm rule updates should not require a service restart. LISTEN/NOTIFY is a native PostgreSQL mechanism with no additional infrastructure. |
| All detection events indexed to Elasticsearch | Audit trail requirement: every scan must be provable. Background baseline data. Compliance reporting. Not just alarm events. |
| No MQTT | HTTP detection event submission is sufficient to demonstrate the ingestion architecture. README acknowledges MQTT as the real-world device protocol for constrained IoT devices. |
| No auth/RBAC | Out of scope for a weekend demo. README describes what production auth would look like: OIDC for operators, certificate-based device identity. |
| No cloud services | All infrastructure runs in-cluster via simple Helm sub-charts using official upstream images, mirroring the air-gapped deployment model. Bitnami charts are no longer free (Broadcom subscription required since Sept 2025); Elastic's standalone Helm charts are archived. Writing simple sub-charts avoids these dependencies entirely. |
| Single modality in simulator | Demo implements `RADIATION_SCAN` / `RadiationPayload` only. Envelope pattern makes extensibility to `XRAY_SCAN`, `CBRN_DETECTION` explicit in the schema. README names this. |
| TypeScript throughout | Confirmed as the target platform's backend language. |

---

## Definition of Done

- [ ] All six services running as pods in K3s (`kubectl get pods` all Running — includes telemetry-simulator)
- [ ] All three Bitnami infrastructure charts deployed and healthy
- [ ] Alarm path verified end-to-end: scenario trigger → ingestion → alert-engine (synchronous) → api-service → WebSocket → Angular dashboard, alarm appears within 2 seconds
- [ ] Indexing path verified: detection events appear in Elasticsearch `detection-events` index; Detection Event Search view returns results
- [ ] Alarm acknowledgement persists to PostgreSQL; acknowledged alarm leaves Active Alarms panel
- [ ] Hot-reload verified: update an alarm rule threshold in PostgreSQL, confirm alert-engine picks it up without restart
- [ ] Device offline detection verified: stop the simulator, confirm device cards show OFFLINE within 30 seconds
- [ ] All six services emit structured JSON logs verifiable via `kubectl logs`
- [ ] All six services expose `/metrics`; Prometheus is scraping them (verify via Prometheus targets page)
- [ ] All three Grafana dashboards load and show live data; `alert_engine_evaluate_duration_seconds` shows a latency spike when a scenario is triggered
- [ ] Umbrella Helm chart deploys full stack from single `helm install`
- [ ] `values-central.yaml` profile disables ingestion services
- [ ] Angular dashboard and Grafana accessible on public URL
- [ ] GitHub repo public with README
- [ ] CI pipeline passes on main: typecheck, lint, Vitest tests, Docker build
- [ ] alert-engine rule evaluation unit tests passing (all cases in Testing spec)
- [ ] ingestion-service alarm path ordering test passing (all three assertions)
