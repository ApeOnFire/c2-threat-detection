---
status: Ready for Implementation
created: 2026-04-27
updated: 2026-04-27
related_docs:
  - docs/plans/roadmap.md
  - docs/plans/phase-8-helm-charts.md
  - docs/plans/phase-9-local-k3s.md
---

# Phase 10: Observability — Implementation Plan

## Context

Phase 8 produced all Dockerfiles and Helm charts. Phase 9 (draft plan) covers K3s deployment. Phase 10 adds Prometheus and Grafana to the running stack so the demo has live dashboards showing the alarm path, indexing pipeline, and device activity.

**What success looks like:** after `helm upgrade`, Prometheus is scraping all five Node services, Grafana at `http://localhost/grafana` shows three pre-provisioned dashboards, and Prometheus UI is accessible at `http://localhost/prometheus`. Triggering a scenario causes `alert_engine_evaluate_duration_seconds` to record a data point and `bullmq_queue_depth` to spike and fall.

**Why Grafana dashboards are a manual step:** Grafana JSON is verbose (~500–2000 lines per dashboard), tightly coupled to the running data, and designed to be iterated in the UI. The plan produces all scaffolding and leaves three stub files (`{}`) for the human to populate after the cluster is running with live data.

**Release name constraint:** `vantage-demo` must be used as the Helm release name throughout this phase. Scrape targets, the Grafana datasource URL, and the `dashboardsConfigMaps` reference all hardcode service names derived from this release name. Any other release name will require updating these values.

---

## Scope

**Two code changes** (small, needed to support the planned dashboards):
1. Add `deviceId` label to `ingestion_events_total` in ingestion-service
2. Add `alert_engine_alarms_triggered_total` counter to alert-engine

**Helm chart changes** (main work):
1. Add Prometheus and Grafana as umbrella chart dependencies
2. Configure static scrape targets for all five Node services
3. Configure Grafana datasource + dashboard provisioning
4. Add `/grafana` and `/prometheus` paths to the nginx ingress

**Manual step (human, done after cluster is running):**
- Build three dashboards in the Grafana UI using the PromQL queries documented here
- Export JSON and replace the stub files

---

## Part 1: Code Changes — Metrics Additions

Run `pnpm typecheck && pnpm test` after completing both changes before moving to the Helm work.

### 1.1 ingestion-service: add `deviceId` label

The `device-activity` dashboard needs events broken down by device. The current counter only has `eventType` and `platformAlarmStatus`.

**Important:** adding a label to an existing Prometheus counter changes the time series identity. On a fresh K3s install (the Phase 9 starting point) this is invisible. On an upgraded cluster, old time series (without `deviceId`) coexist with new ones until they age out of TSDB retention (~15 days by default). For a fresh demo deployment this is a non-issue.

**File: `apps/ingestion-service/src/metrics.ts`**

Change `labelNames` to add `'deviceId'`:
```typescript
export const ingestionEventsTotal = new Counter({
  name: 'ingestion_events_total',
  help: 'Total detection events processed by ingestion-service',
  labelNames: ['deviceId', 'eventType', 'platformAlarmStatus'],
  registers: [registry],
});
```

**File: `apps/ingestion-service/src/routes/events.ts`** — update the `.inc()` call at line 92:
```typescript
ingestionEventsTotal.inc({
  deviceId: enrichedEvent.deviceId,
  eventType: enrichedEvent.eventType,
  platformAlarmStatus: enrichedEvent.platformAlarmStatus,
});
```

### 1.2 alert-engine: add `alarmsTriggeredTotal` counter

The `device-activity` dashboard shows alarm count by subtype. The evaluate handler writes alarms to PostgreSQL but emits no Prometheus counter.

**File: `apps/alert-engine/src/metrics.ts`** — add the counter:
```typescript
import { Registry, Histogram, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const evaluateDurationSeconds = new Histogram({
  name: 'alert_engine_evaluate_duration_seconds',
  help: 'End-to-end latency of POST /evaluate (rule eval + DB write)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const alarmsTriggeredTotal = new Counter({
  name: 'alert_engine_alarms_triggered_total',
  help: 'Total new alarms written to PostgreSQL, by subtype',
  labelNames: ['alarmSubtype'],
  registers: [registry],
});
```

**File: `apps/alert-engine/src/routes/evaluate.ts`** — increment only for genuinely new alarms (not idempotent re-evaluations). Update the import and add the increment inside the `else` branch (line 59–61) where `insertResult.rows.length > 0`:

```typescript
import { evaluateDurationSeconds, alarmsTriggeredTotal } from '../metrics.js';
```

```typescript
// in the else branch (new alarm, not duplicate):
} else {
  alarmId = insertResult.rows[0].id;
  alarmsTriggeredTotal.inc({ alarmSubtype: result.alarmSubtype });
}
```

The idempotent re-evaluation path (`insertResult.rows.length === 0`) must NOT increment the counter — duplicate calls from BullMQ retries would inflate the count. Only the `else` branch represents a genuinely new alarm row.

---

## Part 2: Helm Chart Changes

### 2.1 Add Prometheus and Grafana as umbrella chart dependencies

Add them to the umbrella chart so a single `helm upgrade` deploys everything. Both charts install in the `vantage` namespace alongside the app services, which makes service discovery straightforward (short DNS names work within the namespace) and allows the existing ingress to route `/grafana` and `/prometheus`.

First, add the Helm repos and find the latest stable chart versions:
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
helm search repo prometheus-community/prometheus --versions | head -3
helm search repo grafana/grafana --versions | head -3
```

Note the exact version numbers (format: `X.Y.Z`) — you need them for the next step.

**File: `helm/vantage-demo/Chart.yaml`** — append to the `dependencies` list, replacing `X.Y.Z` with the exact versions found above:
```yaml
  - name: prometheus
    version: "X.Y.Z"           # exact version from helm search
    repository: "https://prometheus-community.github.io/helm-charts"
    condition: prometheus.enabled
  - name: grafana
    version: "X.Y.Z"           # exact version from helm search
    repository: "https://grafana.github.io/helm-charts"
    condition: grafana.enabled
```

After editing `Chart.yaml`, regenerate the lock and download the chart archives:
```bash
helm dependency update helm/vantage-demo
```

This adds two new `.tgz` files to `helm/vantage-demo/charts/` (gitignored) and updates `Chart.lock` (committed).

### 2.2 Configure Prometheus and Grafana in values.yaml

**File: `helm/vantage-demo/values.yaml`** — append the following blocks at the root level (not nested under any existing key):

```yaml
# ── Prometheus ──────────────────────────────────────────────────────────────
prometheus:
  enabled: true
  alertmanager:
    enabled: false
  prometheus-pushgateway:
    enabled: false
  kube-state-metrics:
    enabled: true
  prometheus-node-exporter:
    enabled: false
  server:
    persistentVolume:
      enabled: false        # emptyDir — data resets on pod restart, fine for demo
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    baseURL: "http://localhost/prometheus"
    prefixURL: "/prometheus"
  extraScrapeConfigs: |
    - job_name: 'vantage-telemetry-simulator'
      metrics_path: /metrics
      static_configs:
        - targets: ['vantage-demo-telemetry-simulator:3000']
          labels:
            service: telemetry-simulator

    - job_name: 'vantage-ingestion-service'
      metrics_path: /metrics
      static_configs:
        - targets: ['vantage-demo-ingestion-service:3001']
          labels:
            service: ingestion-service

    - job_name: 'vantage-alert-engine'
      metrics_path: /metrics
      static_configs:
        - targets: ['vantage-demo-alert-engine:3002']
          labels:
            service: alert-engine

    - job_name: 'vantage-event-store-service'
      metrics_path: /metrics
      static_configs:
        - targets: ['vantage-demo-event-store-service:3003']
          labels:
            service: event-store-service

    - job_name: 'vantage-api-service'
      metrics_path: /metrics
      static_configs:
        - targets: ['vantage-demo-api-service:3004']
          labels:
            service: api-service

# ── Grafana ──────────────────────────────────────────────────────────────────
grafana:
  enabled: true
  adminPassword: vantage    # local dev only — overridden at deploy time for EC2 (see Phase 12)
  resources:
    requests:
      memory: 128Mi
      cpu: 50m
    limits:
      memory: 256Mi
      cpu: 250m
  grafana.ini:
    server:
      root_url: "%(protocol)s://%(domain)s:%(http_port)s/grafana"
      serve_from_sub_path: true
  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
        - name: Prometheus
          type: prometheus
          url: http://vantage-demo-prometheus-server:80
          access: proxy
          isDefault: true
          uid: vantage-prometheus   # fixed UID — dashboard JSON exports will reference this and resolve correctly on any cluster
  dashboardProviders:
    dashboardproviders.yaml:
      apiVersion: 1
      providers:
        - name: vantage
          orgId: 1
          folder: Vantage
          type: file
          disableDeletion: false
          updateIntervalSeconds: 30
          options:
            path: /var/lib/grafana/dashboards/vantage
  dashboardsConfigMaps:
    vantage: vantage-demo-grafana-dashboards
```

**Service name conventions (why they work):**

- Prometheus server: the `prometheus-community/prometheus` chart creates a Service named `{release}-prometheus-server`. With release `vantage-demo`, that's `vantage-demo-prometheus-server` at port 80 (maps to container port 9090).
- Grafana: creates `{release}-grafana` at port 80.
- The scrape targets use short service names (`vantage-demo-alert-engine:3002` without `.vantage.svc.cluster.local`) because Prometheus is in the same namespace as the app services.

**`server.baseURL` and `server.prefixURL` for Prometheus sub-path:** without these, Prometheus loads at `/prometheus` but all internal asset references point to `/` — the UI renders broken. `prefixURL` sets the route prefix; `baseURL` sets the external URL for link generation.

**`server.global` version note:** if `helm lint` warns about `server.global` being an unknown field, the chart version you selected uses `serverFiles.prometheus.yml.global` instead. Switch to:
```yaml
prometheus:
  serverFiles:
    prometheus.yml:
      global:
        scrape_interval: 15s
        evaluation_interval: 15s
```

**Why `persistentVolume: false` for Prometheus:** for a demo that's reset regularly, losing metrics on pod restart is acceptable. The Phase 10 manual dashboard step requires only minutes of data. Enabling the PVC adds a PersistentVolumeClaim that complicates teardown/reset cycles and is not needed for the demo.

**Why `kube-state-metrics: enabled: true`:** kube-state-metrics adds Kubernetes object-state metrics (`kube_pod_status_ready`, `kube_deployment_status_replicas`, etc.) at ~100 MB RAM overhead. Pod CPU and memory come separately from cAdvisor (built into the kubelet scrape). Together these enable the optional fourth dashboard — worth the overhead for the demo.

**Admin password (local vs. EC2):** `adminPassword: vantage` stays in `values.yaml` for local development (cluster is local, no exposure). For EC2 (Phase 12), override at deploy time:
```bash
helm upgrade vantage-demo helm/vantage-demo \
  --namespace vantage \
  --set grafana.adminPassword=$GRAFANA_ADMIN_PASSWORD
```
Add `GRAFANA_ADMIN_PASSWORD` to GitHub Actions secrets alongside `EC2_SSH_KEY` and `EC2_HOST`. No Kubernetes Secret manifest needed.

### 2.3 Update the ingress with `/grafana` and `/prometheus` paths

**File: `helm/vantage-demo/templates/ingress.yaml`** — replace the `spec:` section only. The `metadata.annotations` block (WebSocket timeout settings) must be left untouched:

```yaml
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-api-service
                port:
                  number: {{ .Values.global.services.apiService.port }}
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-api-service
                port:
                  number: {{ .Values.global.services.apiService.port }}
          {{- if .Values.grafana.enabled }}
          - path: /grafana
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-grafana
                port:
                  number: 80
          {{- end }}
          {{- if .Values.prometheus.enabled }}
          - path: /prometheus
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-prometheus-server
                port:
                  number: 80
          {{- end }}
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-dashboard
                port:
                  number: {{ .Values.global.services.dashboard.port }}
```

**Path ordering:** nginx-ingress uses longest-prefix-match. `/grafana` and `/prometheus` win over `/` for their respective prefixes. The `{{- if }}` guards prevent dangling backend references when either component is disabled (`helm upgrade --set grafana.enabled=false` won't produce a broken Ingress resource).

**Grafana sub-path:** requests arrive at Grafana with the full `/grafana/...` path. `serve_from_sub_path: true` in `grafana.ini` tells Grafana to handle requests at this prefix — no nginx path rewriting needed.

**Prometheus sub-path:** requests arrive at Prometheus with the full `/prometheus/...` path. `prefixURL: /prometheus` in the server values configures Prometheus to handle routes at this prefix correctly.

**Note when navigating to Grafana via port-forward:** if you port-forward Grafana and navigate to the bare port (e.g., `http://localhost:3100/`), Grafana will redirect to `/grafana/login` — which resolves correctly at `localhost:3100/grafana/login`. Navigate directly to `http://localhost:3100/grafana` to avoid the redirect. Do not rely on the bare port root.

### 2.4 Add observability overrides to values-central.yaml

For a more production-like profile, enable Prometheus persistence.

**File: `helm/vantage-demo/values-central.yaml`** — append:
```yaml
prometheus:
  server:
    persistentVolume:
      enabled: true
      size: 5Gi
    retention: "7d"

grafana:
  persistence:
    enabled: true
    size: 1Gi
    storageClassName: ""   # empty string = use cluster default (local-path in K3s)
  resources:
    requests:
      memory: 256Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m
```

### 2.5 Create the dashboard ConfigMap template

This template reads the three JSON stub files from `helm/vantage-demo/dashboards/` and mounts them into Grafana via a ConfigMap. When the ConfigMap is updated (e.g., after replacing a stub with real dashboard JSON), Kubernetes syncs the volume mount within ~1–2 minutes, then Grafana's file provider picks up the change within a further 30 seconds (`updateIntervalSeconds`). Total expected delay after `helm upgrade`: **2–3 minutes**. No pod restart needed.

**The three stub files in `helm/vantage-demo/dashboards/` must exist before any `helm install` or `helm upgrade`.** The Grafana chart's `dashboardsConfigMaps` creates a Kubernetes volume mount with no `optional: true` flag — if the referenced ConfigMap fails to render (e.g., the `dashboards/` directory is missing from the checkout), the Grafana pod will be stuck in `FailedMount`. Always verify the directory exists with at least the three `{}` stubs before running Helm commands.

**File: `helm/vantage-demo/templates/grafana-dashboards-configmap.yaml`** (new file):
```yaml
{{- if .Values.grafana.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-grafana-dashboards
  namespace: {{ .Release.Namespace }}
  labels:
    app.kubernetes.io/name: grafana-dashboards
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
data:
{{ (.Files.Glob "dashboards/*.json").AsConfig | indent 2 }}
{{- end }}
```

**Why `.AsConfig`:** `.Files.Glob "dashboards/*.json"` returns all matching files as a map. `.AsConfig` formats them as a valid YAML map with correct block-scalar indentation — keys are file basenames, values are file contents. `indent 2` aligns the whole block under `data:`. This handles multi-line JSON correctly (unlike `indent 4` on individual `.Files.Get` calls, which double-indents the first line and breaks YAML parsing). It also means adding a fourth dashboard later requires no template change — just add the file.

**Stub files** — create these three files, each containing only `{}`. Grafana logs a warning for `{}` (not a valid dashboard) and skips it, but does not crash. The cluster starts cleanly.

**File: `helm/vantage-demo/dashboards/alarm-path-health.json`**
```json
{}
```

**File: `helm/vantage-demo/dashboards/indexing-path-health.json`**
```json
{}
```

**File: `helm/vantage-demo/dashboards/device-activity.json`**
```json
{}
```

---

## Part 3: Manual Dashboard Building (Human Step)

This step cannot be automated — it requires interacting with the running Grafana UI with live data flowing. An implementation agent should NOT attempt to hand-author Grafana dashboard JSON.

### Prerequisites

- K3s cluster running with Phase 9 complete (all nine pods + nginx-ingress running)
- Phase 10 deployed (see Verification section for the exact `helm upgrade` command)
- Telemetry simulator has been running for at least 2 minutes (so there is data in Prometheus)

### 3.1 Verify Prometheus has data

Navigate to `http://localhost/prometheus` (via nginx-ingress). Click Status → Targets.

Expected: five `vantage-*` job targets plus kube-state-metrics targets, all green (UP).

Or via API:
```bash
curl -s http://localhost/prometheus/api/v1/targets \
  | jq '.data.activeTargets[] | select(.labels.job | startswith("vantage")) | {job:.labels.job, health:.health}'
```

If any vantage target is DOWN, check the service name in the scrape config against actual services (`kubectl get svc -n vantage`).

### 3.2 Open Grafana

Navigate to `http://localhost/grafana` (via nginx-ingress).

Login: `admin` / `vantage`

The Prometheus datasource should already be configured. Confirm: Connections → Data sources → Prometheus → "Save & test" → green.

### 3.3 Dashboard specifications and PromQL queries

Build each dashboard in the Grafana UI, then export via Dashboard → Share → Export → Save to file. Replace the corresponding stub with the exported JSON.

---

#### Dashboard 1: `alarm-path-health.json`

**Title:** Alarm Path Health  
**Description:** Tracks the ingestion-to-alert-engine pipeline. Useful for confirming the alarm path is handling events and not degrading.

| Panel | Type | PromQL |
|-------|------|--------|
| Event rate (total) | Time series | `rate(ingestion_events_total[5m])` |
| Alarm rate | Time series | `rate(ingestion_events_total{platformAlarmStatus="ALARM"}[5m])` |
| Evaluate duration P50 | Stat / Time series | `histogram_quantile(0.5, rate(alert_engine_evaluate_duration_seconds_bucket[5m]))` |
| Evaluate duration P99 | Stat / Time series | `histogram_quantile(0.99, rate(alert_engine_evaluate_duration_seconds_bucket[5m]))` |
| Evaluate throughput (calls/sec) | Time series | `rate(alert_engine_evaluate_duration_seconds_count[5m])` |

**Suggested layout:** P50 and P99 as Stat panels at the top (big numbers), then two Time series panels below — one for event/alarm rates, one for evaluate throughput. Time range: Last 15 minutes. Refresh: 10s.

---

#### Dashboard 2: `indexing-path-health.json`

**Title:** Indexing Path Health  
**Description:** Tracks the async BullMQ → Elasticsearch pipeline. Queue depth rising without falling indicates event-store-service is stuck.

| Panel | Type | PromQL |
|-------|------|--------|
| Queue depth | Gauge / Time series | `bullmq_queue_depth` |
| Indexing rate | Time series | `rate(event_store_jobs_processed_total[5m])` |
| Total indexed | Stat | `event_store_jobs_processed_total` |

**Suggested layout:** Queue depth as a Gauge (target: 0) at the top, then Time series for queue depth over time and indexing rate side by side. Include a threshold on the queue gauge at 10 (orange) and 50 (red). Time range: Last 15 minutes. Refresh: 10s.

---

#### Dashboard 3: `device-activity.json`

**Title:** Device Activity  
**Description:** Per-device event throughput and alarm breakdown by subtype. Shows which devices are active and what alarm types are being triggered.

| Panel | Type | PromQL |
|-------|------|--------|
| Events per minute per device | Time series | `sum by (deviceId) (rate(ingestion_events_total[1m]) * 60)` — Legend: `{{deviceId}}` |
| Alarms triggered (rate) | Time series | `rate(alert_engine_alarms_triggered_total[5m])` — Legend: `{{alarmSubtype}}` |
| Alarms total by subtype | Bar chart | `alert_engine_alarms_triggered_total` — Legend: `{{alarmSubtype}}` |

**Suggested layout:** Events-per-minute time series across the top (one line per device — PM-01, PM-02, RIID-01), alarms rate time series in the middle, alarms total bar chart at the bottom. Time range: Last 30 minutes. Refresh: 10s.

---

#### Optional Dashboard 4: Pod Resource Usage

The prometheus-community/prometheus chart scrapes the kubelet's cAdvisor endpoint by default (its built-in `kubernetes-nodes` job), making container CPU and memory metrics available without any extra configuration. `kube-state-metrics` provides separate object-state metrics (`kube_pod_status_ready`, `kube_deployment_status_replicas`, etc.) — useful for pod health panels but not the source of the resource-usage metrics below.

| Panel | Type | PromQL |
|-------|------|--------|
| Pod memory (working set) | Time series | `container_memory_working_set_bytes{namespace="vantage"}` — Legend: `{{pod}}` |
| Pod CPU usage | Time series | `rate(container_cpu_usage_seconds_total{namespace="vantage"}[5m])` — Legend: `{{pod}}` |
| Pod readiness | Stat | `kube_pod_status_ready{namespace="vantage",condition="true"}` — Legend: `{{pod}}` |

This is optional — build it if time allows and it adds value to the demo.

### 3.4 Export and commit

After building each dashboard:
1. Dashboard → Share → Export → toggle "Export for sharing externally" OFF → Save to file
2. Replace the corresponding stub file in `helm/vantage-demo/dashboards/`
3. Run `helm upgrade` (same command as initial deploy) — Grafana reloads the dashboard within 2–3 minutes (K8s ConfigMap sync + Grafana's 30s file-check interval), no pod restart needed

---

## Verification

### Step 1: Code changes

```bash
pnpm typecheck
pnpm test
```

Both must pass before proceeding to Helm work.

### Step 2: Pre-deploy lint check

If running on a fresh clone, register the Helm repos first (one-time per machine):
```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

Then download dependencies and lint:
```bash
helm dependency update helm/vantage-demo

# Strict lint of our templates only:
helm lint helm/vantage-demo --strict

# Permissive full-tree check (warnings from external charts are expected noise — do not block on them):
helm lint helm/vantage-demo --with-subcharts
```

Expected from the strict check: `1 chart(s) linted, 0 chart(s) failed`. The `--with-subcharts` run may show warnings from the prometheus or grafana charts themselves — those are outside our control and do not indicate a problem with our templates.

### Step 3: Deploy

From Phase 9 base state (nine pods already running):

```bash
helm upgrade vantage-demo helm/vantage-demo \
  --namespace vantage \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

### Step 4: Watch startup

```bash
kubectl get pods -n vantage -w
```

Three new pods in addition to the nine from Phase 9:

| Pod | Typical ready time | Notes |
|-----|--------------------|-------|
| vantage-demo-prometheus-server | ~60s | Starts scraping immediately; targets appear after first scrape interval |
| vantage-demo-grafana | ~30s | Reads provisioned datasource + dashboard configmaps |
| vantage-demo-kube-state-metrics | ~20s | Separate pod from kube-state-metrics subchart |

Total: **twelve pods** Running after Phase 10 (nine from Phase 9 + prometheus-server + grafana + kube-state-metrics).

### Step 5: Prometheus targets

```bash
curl -s http://localhost/prometheus/api/v1/targets \
  | jq '.data.activeTargets[] | select(.labels.job | startswith("vantage")) | {job:.labels.job, health:.health}'
```

Expected: five entries, all `"health": "up"`. If DOWN with `connection refused`, wait 30 seconds — the service may not have passed its readiness probe yet.

### Step 6: Grafana datasource

Open `http://localhost/grafana` → admin/vantage → Connections → Data sources → Prometheus → Save & test → green checkmark.

### Step 7: Metrics spot-check

In Grafana Explore or the Prometheus UI at `http://localhost/prometheus`:

```
alert_engine_evaluate_duration_seconds_count
ingestion_events_total
bullmq_queue_depth
alert_engine_alarms_triggered_total
```

All four should return time series within a minute of the telemetry simulator running. Trigger a scenario to force non-zero alarm metrics:
```bash
curl -X POST http://localhost/api/scenarios/norm-threshold
```

---

## Definition of Done

Phase 10 is complete when all of the following are true:

**Code:**
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes

**Infrastructure:**
- [ ] `kubectl get pods -n vantage` — all twelve pods Running (nine from Phase 9 + prometheus-server + grafana + kube-state-metrics)
- [ ] `helm lint helm/vantage-demo --strict` — 0 failures (run `--with-subcharts` separately; warnings from external charts are expected noise and do not block)

**Prometheus:**
- [ ] `http://localhost/prometheus` loads Prometheus UI
- [ ] All five vantage service targets show UP in Status → Targets
- [ ] `rate(ingestion_events_total[5m])` returns non-zero data after simulator runs ~2 min
- [ ] `alert_engine_evaluate_duration_seconds_bucket` shows histogram data

**Grafana:**
- [ ] `http://localhost/grafana` loads (login: admin/vantage)
- [ ] Prometheus datasource shows "Data source connected and labels found"
- [ ] Vantage dashboards folder visible (stubs load as empty/warning until manual step)

**Manual dashboards (after human builds them):**
- [ ] `alarm-path-health` loads with live evaluate duration data
- [ ] Triggering a scenario causes a spike in evaluate duration P99
- [ ] `indexing-path-health` shows `bullmq_queue_depth` rise and fall after scenario
- [ ] `device-activity` shows three separate device lines for events per minute

---

## Files Changed Summary

| File | Action |
|------|--------|
| `apps/ingestion-service/src/metrics.ts` | Add `'deviceId'` to `labelNames` |
| `apps/ingestion-service/src/routes/events.ts` | Add `deviceId` to `.inc()` call |
| `apps/alert-engine/src/metrics.ts` | Add `alarmsTriggeredTotal` counter export |
| `apps/alert-engine/src/routes/evaluate.ts` | Import + increment `alarmsTriggeredTotal` in `else` branch |
| `helm/vantage-demo/Chart.yaml` | Add prometheus + grafana dependencies (exact versions from `helm search`) |
| `helm/vantage-demo/values.yaml` | Add prometheus (scrape config, sub-path, kube-state-metrics) + grafana (datasource, provisioning, resources, sub-path) |
| `helm/vantage-demo/values-central.yaml` | Add Prometheus persistence + Grafana persistence + resource overrides |
| `helm/vantage-demo/templates/ingress.yaml` | Add `/grafana` (guarded by `grafana.enabled`) and `/prometheus` (guarded by `prometheus.enabled`) paths |
| `helm/vantage-demo/templates/grafana-dashboards-configmap.yaml` | New — uses `.Files.Glob.AsConfig` to embed dashboard JSONs |
| `helm/vantage-demo/dashboards/alarm-path-health.json` | New stub `{}` |
| `helm/vantage-demo/dashboards/indexing-path-health.json` | New stub `{}` |
| `helm/vantage-demo/dashboards/device-activity.json` | New stub `{}` |
