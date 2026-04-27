---
status: Ready for Implementation
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/plans/roadmap.md
  - docs/plans/phase-7-angular-dashboard.md
---

# Phase 8: Helm Charts + Dockerfiles — Implementation Plan

## Context

Phase 8 produces all Dockerfiles and Helm charts needed to deploy the Vantage platform to Kubernetes (K3s). This phase requires no running cluster — it is fully verifiable with `helm lint`, `helm template --dry-run`, and `docker build`.

**Prerequisite:** Phase 7 (Angular dashboard) must be implemented before Phase 8 begins. The dashboard Dockerfile references `apps/dashboard/package.json` and `apps/dashboard/angular.json`, which don't exist until Phase 7. All other Dockerfiles and Helm charts can be created and verified immediately.

Six services after Phase 7: `telemetry-simulator`, `ingestion-service`, `alert-engine`, `event-store-service`, `api-service`, and `dashboard` (Angular). Three infrastructure components: PostgreSQL 18, Redis 8, Elasticsearch 8.17.

**Helm version:** 4. Key Helm 4 facts:
- `apiVersion: v2` is still correct — Charts v3 format is in development, not released
- `dependencies:` syntax in Chart.yaml is unchanged from Helm 3
- `--atomic` is renamed `--rollback-on-failure` in Helm 4
- Server-Side Apply is the new default for fresh installs — fine for K3s

---

## Research Corrections to the Roadmap

These are corrections discovered through web research. Follow these, not the roadmap values:

| Item | Roadmap Says | Correct Value | Source |
|------|-------------|---------------|--------|
| ES `vm.max_map_count` | 262144 | **1048576** | ES 8.16+ requirement |
| ES initContainer | no `runAsUser` | `runAsUser: 0` required | ECK issue #5410, ES 8.0+ |
| ES enrollment flag | not mentioned | `xpack.security.enrollment.enabled: false` required | ES 8.x |
| pnpm deploy flag | not mentioned | `--legacy` required for pnpm v10 | pnpm v10 changelog |
| Angular build output | `dist/dashboard/` | `dist/dashboard/browser/` | Angular 17+ application builder |
| `tsx` location | devDependencies | must be in **dependencies** | `pnpm deploy --prod` drops devDeps |

---

## Part 1: Prerequisites — Package.json Changes

### 1.1 Move `tsx` to `dependencies`

`tsx` must move from `devDependencies` to `dependencies` in every service package.json. `pnpm deploy --prod` strips devDependencies; without this change the container has no way to run the TypeScript source.

**Modify these five files** — in each, move `"tsx": "^4.0.0"` from `devDependencies` to `dependencies`:
- `apps/alert-engine/package.json`
- `apps/api-service/package.json`
- `apps/event-store-service/package.json`
- `apps/ingestion-service/package.json`
- `apps/telemetry-simulator/package.json`

Example result for `apps/alert-engine/package.json`:
```json
{
  "dependencies": {
    "@vantage/types": "workspace:*",
    "fastify": "^5.0.0",
    "node-pg-migrate": "^8.0.0",
    "pg": "^8.0.0",
    "pino": "^10.0.0",
    "prom-client": "^15.0.0",
    "tsx": "^4.0.0"
  },
  "devDependencies": {
    "@types/pg": "^8.0.0",
    "vitest": "^4.0.0"
  }
}
```

### 1.2 Pin pnpm version in root package.json

Add a `packageManager` field to the root `package.json` so corepack uses a deterministic pnpm version in Docker builds. Run `pnpm --version` locally to get the exact version string, then add:

```json
{
  "packageManager": "pnpm@10.x.y"
}
```

Replace `10.x.y` with the actual output of `pnpm --version`. With this field present, the Dockerfiles can use `corepack enable` alone (no `corepack prepare pnpm@... --activate` needed) — corepack reads the version from `packageManager` automatically.

---

## Part 2: Dockerfiles

### 2.1 `.dockerignore`

**Create `.dockerignore` at the monorepo root before building any images.** Without it, Docker sends the entire repo (including all `node_modules/` directories — potentially several GB) to the build daemon on every `docker build`. This makes builds take minutes just on context transfer.

**`.dockerignore`**:
```
.git
.env
**/node_modules
**/dist
**/.angular
**/coverage
```

### 2.2 Node Services — Pattern

All five Node service Dockerfiles follow this identical pattern. The build context is always the **monorepo root**.

Two stages:
1. **build** — full workspace install, then `pnpm deploy` to create a self-contained directory for one service
2. **runtime** — minimal node:22-alpine image with only the deployed directory

Key decisions:
- All `apps/*/package.json` files are copied in the manifest layer (not just the target service's). This prevents pnpm workspace resolution errors when `pnpm-workspace.yaml` declares `apps/*` but only some package.json files are present. This layer only rebuilds when any service dependency changes.
- `pnpm fetch` first (populates virtual store from lockfile) + `pnpm install --frozen-lockfile --prefer-offline` for optimal layer caching with no unnecessary network access.
- `pnpm deploy --prod --legacy` — `--prod` drops devDeps, `--legacy` is required for pnpm v10.
- CMD calls `tsx` directly — avoids the `--env-file=../../.env` in the package.json start script (local-dev convenience, not valid in Docker).
- Env vars come from K8s at runtime (Deployment env block), never from a file.

**Complete Dockerfile — `apps/alert-engine/Dockerfile`** (canonical pattern):

```dockerfile
# syntax=docker/dockerfile:1
# Build context: monorepo root
# docker build -f apps/alert-engine/Dockerfile -t vantage/alert-engine:local .

FROM node:22-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# corepack reads the "packageManager" field from package.json and activates
# that exact pnpm version — no explicit version needed here.
RUN corepack enable

WORKDIR /app

# Copy ALL workspace manifests first. This layer is only invalidated when the
# lockfile or any package.json changes — not when source files change.
# All apps/*/package.json files are required: pnpm-workspace.yaml declares
# apps/* and pnpm will warn/error if any are missing during install.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json ./packages/types/
COPY apps/alert-engine/package.json ./apps/alert-engine/
COPY apps/api-service/package.json ./apps/api-service/
COPY apps/event-store-service/package.json ./apps/event-store-service/
COPY apps/ingestion-service/package.json ./apps/ingestion-service/
COPY apps/telemetry-simulator/package.json ./apps/telemetry-simulator/
COPY apps/dashboard/package.json ./apps/dashboard/

# Fetch all packages from the lockfile into the virtual store.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

# Copy source for this service only, then install from cache.
COPY packages/types/ ./packages/types/
COPY apps/alert-engine/ ./apps/alert-engine/

# --prefer-offline: use virtual store populated by pnpm fetch; avoids
# unnecessary network access during install.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# pnpm deploy produces a self-contained directory with no workspace symlinks:
#   --prod    — excludes devDependencies (tsx must be in dependencies)
#   --legacy  — required for pnpm v10; avoids inject-workspace-packages requirement
RUN pnpm --filter @vantage/alert-engine deploy --prod --legacy /deploy

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /deploy .

EXPOSE 3002

# Do NOT use the package.json "start" script — it has --env-file=../../.env
# which does not exist in Docker. Env vars come from K8s at runtime.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
```

### 2.3 Per-Service Variations

Create this Dockerfile in each service directory. The manifest COPY block is identical across all services (copy ALL apps' package.json files — it doesn't matter that one Dockerfile builds alert-engine but also copies ingestion-service's package.json). Only these three things change per service:

| Service | Service source COPY line | `--filter` argument | `EXPOSE` |
|---------|--------------------------|---------------------|---------|
| `alert-engine` | `COPY apps/alert-engine/ ./apps/alert-engine/` | `@vantage/alert-engine` | 3002 |
| `ingestion-service` | `COPY apps/ingestion-service/ ./apps/ingestion-service/` | `@vantage/ingestion-service` | 3001 |
| `telemetry-simulator` | `COPY apps/telemetry-simulator/ ./apps/telemetry-simulator/` | `@vantage/telemetry-simulator` | 3000 |
| `event-store-service` | `COPY apps/event-store-service/ ./apps/event-store-service/` | `@vantage/event-store-service` | 3003 |
| `api-service` | `COPY apps/api-service/ ./apps/api-service/` | `@vantage/api-service` | 3004 |

Create `apps/{service}/Dockerfile` for each of the remaining four services following the alert-engine pattern exactly, substituting only the service-specific lines above.

### 2.4 Dashboard Dockerfile

Two stages: Angular build → nginx static serve. **`apps/dashboard/Dockerfile`**:

```dockerfile
# syntax=docker/dockerfile:1
# Build context: monorepo root
# docker build -f apps/dashboard/Dockerfile -t vantage/dashboard:local .

FROM node:22-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/types/package.json ./packages/types/
COPY apps/alert-engine/package.json ./apps/alert-engine/
COPY apps/api-service/package.json ./apps/api-service/
COPY apps/event-store-service/package.json ./apps/event-store-service/
COPY apps/ingestion-service/package.json ./apps/ingestion-service/
COPY apps/telemetry-simulator/package.json ./apps/telemetry-simulator/
COPY apps/dashboard/package.json ./apps/dashboard/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch

COPY packages/types/ ./packages/types/
COPY apps/dashboard/ ./apps/dashboard/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# Angular CLI is in apps/dashboard/node_modules/.bin/ after pnpm install.
# Angular 17+ application builder outputs to dist/<project>/browser/.
# Project name confirmed as "dashboard" (from angular.json).
WORKDIR /app/apps/dashboard
RUN node_modules/.bin/ng build --configuration=production

FROM nginx:alpine AS runtime
RUN rm /etc/nginx/conf.d/default.conf
# nginx.conf is copied from the host build context (not the build stage).
# It must exist at apps/dashboard/nginx.conf in the repository.
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
# Angular 17+ output path: dist/dashboard/browser/ (NOT dist/dashboard/)
COPY --from=build /app/apps/dashboard/dist/dashboard/browser /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### 2.5 Dashboard nginx.conf

Create **`apps/dashboard/nginx.conf`**:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml
        image/svg+xml;

    # Angular-hashed assets: filenames contain content hash — cache aggressively.
    location ~* \.(js|css|woff|woff2|ttf|eot|ico|png|jpg|jpeg|gif|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # index.html must never be cached — it references hashed asset filenames
    # and must be fetched fresh after every deploy.
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        add_header Expires "0";
    }

    # Angular client-side routing fallback.
    # The K8s nginx ingress routes /api/* and /ws externally — this nginx
    # only sees / and Angular route paths, not API traffic.
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## Part 3: Helm Charts

### 3.1 Directory Structure

```
helm/
├── charts/                         # subchart source directories (committed)
│   ├── postgres/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   └── templates/
│   │       ├── secret.yaml
│   │       ├── pvc.yaml
│   │       ├── deployment.yaml
│   │       └── service.yaml
│   ├── redis/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   └── templates/
│   │       ├── pvc.yaml
│   │       ├── deployment.yaml
│   │       └── service.yaml
│   ├── elasticsearch/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   └── templates/
│   │       ├── statefulset.yaml
│   │       └── service.yaml
│   ├── telemetry-simulator/
│   │   ├── Chart.yaml
│   │   ├── values.yaml
│   │   └── templates/
│   │       ├── deployment.yaml
│   │       └── service.yaml
│   ├── ingestion-service/       # (same structure as telemetry-simulator)
│   ├── alert-engine/
│   ├── event-store-service/
│   ├── api-service/
│   └── dashboard/
│       ├── Chart.yaml
│       ├── values.yaml
│       └── templates/
│           ├── deployment.yaml
│           └── service.yaml
└── vantage-demo/                    # umbrella chart
    ├── Chart.yaml
    ├── Chart.lock                   # generated by helm dep update — commit this
    ├── values.yaml
    ├── values-central.yaml
    ├── templates/
    │   ├── _helpers.tpl
    │   └── ingress.yaml
    └── charts/                      # generated .tgz archives — gitignore *.tgz
```

Add to `.gitignore`:
```
helm/vantage-demo/charts/*.tgz
```

### 3.2 Naming Convention

All K8s resources (Deployment, Service, StatefulSet, PVC, Secret) are named:

```
{{ .Release.Name }}-{{ .Chart.Name }}
```

With `helm install vantage-demo ./helm/vantage-demo`, this produces:
- `vantage-demo-postgres`, `vantage-demo-redis`, `vantage-demo-elasticsearch`
- `vantage-demo-alert-engine`, `vantage-demo-ingestion-service`, etc.

These become the Kubernetes DNS hostnames within the same namespace. Inter-service URLs in Deployment env blocks are constructed from `.Release.Name` at template render time.

### 3.3 nginx-ingress Requirement

The Ingress uses `configuration-snippet` to pass `Upgrade` and `Connection` headers for WebSocket support. Two flags are required:

1. `controller.allowSnippetAnnotations=true` — enables snippet annotations (disabled by default since v1.9 due to CVE-2021-25742)
2. `controller.config.annotations-risk-level=Critical` — required from **v1.10+**; `configuration-snippet` is classified as `Critical` risk and is silently rejected at the default `High` level even when snippets are enabled. Without this flag WebSocket fails with no error — nginx simply never sends the `Upgrade` header.

```bash
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical
```

This applies to both Phase 9 (Rancher Desktop) and Phase 12 (EC2).

**Note:** `kubernetes/ingress-nginx` entered best-effort-only maintenance in March 2026 (no further security patches). K3s ships Traefik by default, which is a viable alternative for Phase 9 and Phase 12. Switching ingress controllers is a Phase 9 decision — Phase 8 chart artifacts are unaffected either way.

---

### 3.4 Umbrella Chart

**`helm/vantage-demo/Chart.yaml`**:
```yaml
apiVersion: v2
name: vantage-demo
description: Vantage radiation detection C2 platform
type: application
version: 0.1.0
appVersion: "0.1.0"

dependencies:
  - name: postgres
    version: "0.1.0"
    repository: "file://../charts/postgres"
    condition: postgres.enabled
  - name: redis
    version: "0.1.0"
    repository: "file://../charts/redis"
    condition: redis.enabled
  - name: elasticsearch
    version: "0.1.0"
    repository: "file://../charts/elasticsearch"
    condition: elasticsearch.enabled
  - name: telemetry-simulator
    version: "0.1.0"
    repository: "file://../charts/telemetry-simulator"
    condition: telemetry-simulator.enabled
  - name: ingestion-service
    version: "0.1.0"
    repository: "file://../charts/ingestion-service"
    condition: ingestion-service.enabled
  - name: alert-engine
    version: "0.1.0"
    repository: "file://../charts/alert-engine"
    condition: alert-engine.enabled
  - name: event-store-service
    version: "0.1.0"
    repository: "file://../charts/event-store-service"
    condition: event-store-service.enabled
  - name: api-service
    version: "0.1.0"
    repository: "file://../charts/api-service"
    condition: api-service.enabled
  - name: dashboard
    version: "0.1.0"
    repository: "file://../charts/dashboard"
    condition: dashboard.enabled
```

**`helm/vantage-demo/values.yaml`**:
```yaml
global:
  imageTag: latest
  imagePullPolicy: IfNotPresent
  postgres:
    user: vantage
    password: vantage
    database: vantage
    port: 5432
  redis:
    port: 6379
  elasticsearch:
    port: 9200
  services:
    telemetrySimulator:
      port: 3000
    ingestionService:
      port: 3001
    alertEngine:
      port: 3002
    eventStoreService:
      port: 3003
    apiService:
      port: 3004
    dashboard:
      port: 80

postgres:
  enabled: true
  image:
    repository: postgres
    tag: "18-alpine"
  persistence:
    size: 1Gi
    storageClass: ""

redis:
  enabled: true
  image:
    repository: redis
    tag: "8-alpine"
  persistence:
    size: 1Gi
    storageClass: ""

elasticsearch:
  enabled: true
  image:
    repository: docker.elastic.co/elasticsearch/elasticsearch
    tag: "8.17.0"
  javaOpts: "-Xms512m -Xmx512m"
  resources:
    requests:
      memory: "1Gi"
      cpu: "250m"
    limits:
      memory: "1Gi"
      cpu: "1000m"
  persistence:
    size: 5Gi
    storageClass: ""

telemetry-simulator:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/telemetry-simulator
    tag: ""

ingestion-service:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/ingestion-service
    tag: ""

alert-engine:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/alert-engine
    tag: ""

event-store-service:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/event-store-service
    tag: ""

api-service:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/api-service
    tag: ""

dashboard:
  enabled: true
  replicaCount: 1
  image:
    repository: vantage/dashboard
    tag: ""
```

**`helm/vantage-demo/values-central.yaml`** (central command profile):
```yaml
# Raises ES heap to 1g. Memory limit must be at least 2x heap — raised to 2Gi
# so the JVM has room for off-heap caches alongside the 1g heap.
elasticsearch:
  javaOpts: "-Xms1g -Xmx1g"
  resources:
    requests:
      memory: "2Gi"
      cpu: "500m"
    limits:
      memory: "2Gi"
      cpu: "1000m"
  persistence:
    size: 10Gi

postgres:
  persistence:
    size: 5Gi
```

**`helm/vantage-demo/templates/_helpers.tpl`**:
```
{{- define "vantage-demo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end }}
```

**`helm/vantage-demo/templates/ingress.yaml`**:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}-ingress
  labels:
    app.kubernetes.io/name: ingress
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/managed-by: {{ .Release.Service }}
    helm.sh/chart: {{ include "vantage-demo.chart" . }}
  annotations:
    # WebSocket support for /ws: nginx-ingress must be installed with
    # controller.allowSnippetAnnotations=true for configuration-snippet to work.
    # See Phase 9 and Phase 12 nginx-ingress install commands.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-http-version: "1.1"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_cache_bypass $http_upgrade;
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
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Release.Name }}-dashboard
                port:
                  number: {{ .Values.global.services.dashboard.port }}
```

Remove the `ws-headers-configmap.yaml` — it adds no value. Only the `_helpers.tpl` and `ingress.yaml` templates are needed in the umbrella.

---

### 3.5 Infrastructure Charts

#### 3.5.1 postgres

**`helm/charts/postgres/Chart.yaml`**:
```yaml
apiVersion: v2
name: postgres
description: PostgreSQL for Vantage demo
type: application
version: 0.1.0
appVersion: "18"
```

**`helm/charts/postgres/values.yaml`**:
```yaml
image:
  repository: postgres
  tag: "18-alpine"
persistence:
  size: 1Gi
  storageClass: ""
```

**`helm/charts/postgres/templates/secret.yaml`**:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
type: Opaque
stringData:
  postgres-user: {{ .Values.global.postgres.user | quote }}
  postgres-password: {{ .Values.global.postgres.password | quote }}
  postgres-db: {{ .Values.global.postgres.database | quote }}
```

**`helm/charts/postgres/templates/pvc.yaml`**:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}-data
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: {{ .Values.persistence.size }}
  {{- if .Values.persistence.storageClass }}
  storageClassName: {{ .Values.persistence.storageClass }}
  {{- end }}
```

**`helm/charts/postgres/templates/deployment.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  # Recreate is required for RWO PVCs. RollingUpdate (the default) starts the
  # new pod before the old one terminates, but both cannot mount the same RWO
  # volume — the new pod hangs Pending forever. Recreate kills the old pod first.
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 5432
              protocol: TCP
          env:
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-{{ .Chart.Name }}
                  key: postgres-user
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-{{ .Chart.Name }}
                  key: postgres-password
            - name: POSTGRES_DB
              valueFrom:
                secretKeyRef:
                  name: {{ .Release.Name }}-{{ .Chart.Name }}
                  key: postgres-db
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          readinessProbe:
            exec:
              # Use a shell for env var expansion — K8s does not expand
              # $(VAR) in readinessProbe.exec.command, only in env/command/args.
              command:
                - /bin/sh
                - -c
                - pg_isready -U "$POSTGRES_USER"
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - pg_isready -U "$POSTGRES_USER"
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ .Release.Name }}-{{ .Chart.Name }}-data
```

**`helm/charts/postgres/templates/service.yaml`**:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - port: 5432
      targetPort: 5432
      protocol: TCP
```

#### 3.5.2 redis

Create `helm/charts/redis/` following the postgres pattern with these differences:
- No Secret (Redis has no auth in this demo, matching docker-compose)
- Image: `redis:8-alpine`
- Container port: 6379, PVC mount at `/data`
- `strategy: Recreate` (same RWO PVC reason as postgres)
- Readiness probe uses `redis-cli ping` (no env var substitution needed)

**`helm/charts/redis/Chart.yaml`**:
```yaml
apiVersion: v2
name: redis
description: Redis for Vantage demo
type: application
version: 0.1.0
appVersion: "8"
```

**`helm/charts/redis/values.yaml`**:
```yaml
image:
  repository: redis
  tag: "8-alpine"
persistence:
  size: 1Gi
  storageClass: ""
```

**`helm/charts/redis/templates/pvc.yaml`** — identical to postgres pvc.yaml (name resolves to `{{ .Release.Name }}-redis-data`).

**`helm/charts/redis/templates/deployment.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 6379
              protocol: TCP
          command: ["redis-server", "--appendonly", "yes"]
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: {{ .Release.Name }}-{{ .Chart.Name }}-data
```

**`helm/charts/redis/templates/service.yaml`** — same pattern as postgres, port 6379.

#### 3.5.3 elasticsearch

Elasticsearch uses a **StatefulSet** (not Deployment) — `volumeClaimTemplates` handles PVC creation automatically and guarantees stable binding. StatefulSets do not need `strategy: Recreate` because they replace pods one at a time and properly manage PVC attachment.

**Note on default memory:** Default heap is 512m with a 1Gi container limit (2× minimum). JVM off-heap can push usage beyond 1Gi under even light load on Rancher Desktop. If ES is OOMKilled, raise `elasticsearch.resources.limits.memory` to `1536Mi` in `values.yaml`, or deploy with `values-central.yaml` which already sets 2Gi.

**Critical ES 8.x requirements:**
- `vm.max_map_count=1048576` — ES 8.16+ requires this higher value (not 262144)
- `runAsUser: 0` in the initContainer — required from ES 8.0+
- `xpack.security.enrollment.enabled: false` — suppresses ES 8.x enrollment token behaviour
- Do NOT set `cluster.initial_master_nodes` — fatal error when combined with `single-node`
- Container memory limit must be ≥ 2× heap size — JVM off-heap needs the other half

**`helm/charts/elasticsearch/Chart.yaml`**:
```yaml
apiVersion: v2
name: elasticsearch
description: Elasticsearch for Vantage demo
type: application
version: 0.1.0
appVersion: "8.17.0"
```

**`helm/charts/elasticsearch/values.yaml`**:
```yaml
image:
  repository: docker.elastic.co/elasticsearch/elasticsearch
  tag: "8.17.0"
javaOpts: "-Xms512m -Xmx512m"
resources:
  requests:
    memory: "1Gi"
    cpu: "250m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
persistence:
  size: 5Gi
  storageClass: ""
```

**`helm/charts/elasticsearch/templates/statefulset.yaml`**:
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  serviceName: {{ .Release.Name }}-{{ .Chart.Name }}-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      initContainers:
        - name: increase-vm-max-map
          image: busybox:1.36
          command: ["sh", "-c", "sysctl -w vm.max_map_count=1048576"]
          securityContext:
            privileged: true
            runAsUser: 0
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 9200
              name: http
            - containerPort: 9300
              name: transport
          env:
            - name: discovery.type
              value: "single-node"
            - name: xpack.security.enabled
              value: "false"
            - name: xpack.security.enrollment.enabled
              value: "false"
            - name: ES_JAVA_OPTS
              value: {{ .Values.javaOpts | quote }}
            - name: cluster.name
              value: "vantage-demo"
          readinessProbe:
            httpGet:
              path: /_cluster/health
              port: 9200
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 12
          livenessProbe:
            httpGet:
              path: /_cluster/health
              port: 9200
            # Large initial delay: ES startup can consume the entire readiness
            # window before becoming responsive. Kill only if it stops responding
            # after a healthy start.
            initialDelaySeconds: 120
            periodSeconds: 30
            failureThreshold: 3
          resources:
            requests:
              memory: {{ .Values.resources.requests.memory | quote }}
              cpu: {{ .Values.resources.requests.cpu | quote }}
            limits:
              memory: {{ .Values.resources.limits.memory | quote }}
              cpu: {{ .Values.resources.limits.cpu | quote }}
          volumeMounts:
            - name: data
              mountPath: /usr/share/elasticsearch/data
  volumeClaimTemplates:
    - metadata:
        name: data
        annotations:
          helm.sh/resource-policy: keep
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: {{ .Values.persistence.size }}
        {{- if .Values.persistence.storageClass }}
        storageClassName: {{ .Values.persistence.storageClass }}
        {{- end }}
```

**`helm/charts/elasticsearch/templates/service.yaml`**:
```yaml
# Headless service — governs StatefulSet pod identity. Required by K8s spec
# for StatefulSets. With a single replica and single-node discovery this is
# not used for peer discovery, but must exist and be referenced by serviceName.
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}-headless
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - port: 9200
      targetPort: 9200
      name: http
    - port: 9300
      targetPort: 9300
      name: transport
---
# ClusterIP service — used by other services (ELASTICSEARCH_URL env var).
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - port: 9200
      targetPort: 9200
      name: http
```

---

### 3.6 Application Service Charts

All six application service charts share the same four-file structure: `Chart.yaml`, `values.yaml`, `templates/deployment.yaml`, `templates/service.yaml`.

#### 3.6.1 alert-engine (canonical pattern — complete)

**`helm/charts/alert-engine/Chart.yaml`**:
```yaml
apiVersion: v2
name: alert-engine
description: Alarm evaluator service
type: application
version: 0.1.0
appVersion: "0.1.0"
```

**`helm/charts/alert-engine/values.yaml`**:
```yaml
replicaCount: 1
image:
  repository: vantage/alert-engine
  tag: ""
service:
  port: 3002
```

**`helm/charts/alert-engine/templates/deployment.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Values.global.imageTag | default "latest" }}"
          imagePullPolicy: {{ .Values.global.imagePullPolicy | default "IfNotPresent" }}
          ports:
            - containerPort: {{ .Values.service.port }}
              protocol: TCP
          env:
            - name: PORT
              value: {{ .Values.service.port | quote }}
            - name: DATABASE_URL
              value: "postgresql://{{ .Values.global.postgres.user }}:{{ .Values.global.postgres.password }}@{{ .Release.Name }}-postgres:{{ .Values.global.postgres.port }}/{{ .Values.global.postgres.database }}"
            - name: API_SERVICE_URL
              value: "http://{{ .Release.Name }}-api-service:{{ .Values.global.services.apiService.port }}"
          readinessProbe:
            httpGet:
              path: /health
              port: {{ .Values.service.port }}
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 6
          livenessProbe:
            httpGet:
              path: /health
              port: {{ .Values.service.port }}
            initialDelaySeconds: 60
            periodSeconds: 15
            failureThreshold: 3
```

**Note on startup ordering:** On the first deploy, alert-engine will enter CrashLoopBackoff briefly because it runs DB migrations on startup and postgres may not be ready yet. Once postgres passes its readinessProbe and alert-engine retries, it succeeds. This is expected behaviour — no action needed.

**`helm/charts/alert-engine/templates/service.yaml`**:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: {{ .Values.service.port }}
      protocol: TCP
```

#### 3.6.2 Remaining Service Charts — Specs

Create identical `Chart.yaml`, `values.yaml`, and `service.yaml` for each remaining service (only name and port change). The `deployment.yaml` differs in the `env:` block **and** in the probe settings.

**Probe settings per service** (all use `path: /health`):

| Service | Readiness `initialDelay` | Readiness `failureThreshold` | Liveness `initialDelay` | Reason |
|---------|--------------------------|------------------------------|-------------------------|--------|
| telemetry-simulator | 5s | 3 | 30s | No external deps at startup |
| ingestion-service | 5s | 3 | 30s | Just needs Redis (fast) |
| event-store-service | 15s | 6 | 90s | Waits for ES (ES itself has 30s readiness delay) |
| api-service | 10s | 6 | 60s | Runs DB migrations |

All liveness probes: `periodSeconds: 15, failureThreshold: 3`. All readiness probes: `periodSeconds: 5`. Use the alert-engine spec as the structural template, substituting the values above.

**deployment.yaml env blocks per service:**

---

**`telemetry-simulator`** — port 3000:
```yaml
env:
  - name: PORT
    value: {{ .Values.service.port | quote }}
  - name: INGESTION_SERVICE_URL
    value: "http://{{ .Release.Name }}-ingestion-service:{{ .Values.global.services.ingestionService.port }}"
```

---

**`ingestion-service`** — port 3001:
```yaml
env:
  - name: PORT
    value: {{ .Values.service.port | quote }}
  - name: ALERT_ENGINE_URL
    value: "http://{{ .Release.Name }}-alert-engine:{{ .Values.global.services.alertEngine.port }}"
  - name: REDIS_URL
    value: "redis://{{ .Release.Name }}-redis:{{ .Values.global.redis.port }}"
```

---

**`event-store-service`** — port 3003:
```yaml
env:
  - name: PORT
    value: {{ .Values.service.port | quote }}
  - name: REDIS_URL
    value: "redis://{{ .Release.Name }}-redis:{{ .Values.global.redis.port }}"
  - name: ELASTICSEARCH_URL
    value: "http://{{ .Release.Name }}-elasticsearch:{{ .Values.global.elasticsearch.port }}"
```

---

**`api-service`** — port 3004:
```yaml
env:
  - name: PORT
    value: {{ .Values.service.port | quote }}
  - name: DATABASE_URL
    value: "postgresql://{{ .Values.global.postgres.user }}:{{ .Values.global.postgres.password }}@{{ .Release.Name }}-postgres:{{ .Values.global.postgres.port }}/{{ .Values.global.postgres.database }}"
  - name: REDIS_URL
    value: "redis://{{ .Release.Name }}-redis:{{ .Values.global.redis.port }}"
  - name: ELASTICSEARCH_URL
    value: "http://{{ .Release.Name }}-elasticsearch:{{ .Values.global.elasticsearch.port }}"
  - name: TELEMETRY_SIMULATOR_URL
    value: "http://{{ .Release.Name }}-telemetry-simulator:{{ .Values.global.services.telemetrySimulator.port }}"
```

---

#### 3.6.3 dashboard chart

The dashboard container is a static nginx server — no env vars, port 80.

**`helm/charts/dashboard/Chart.yaml`**:
```yaml
apiVersion: v2
name: dashboard
description: Angular operator dashboard
type: application
version: 0.1.0
appVersion: "0.1.0"
```

**`helm/charts/dashboard/values.yaml`**:
```yaml
replicaCount: 1
image:
  repository: vantage/dashboard
  tag: ""
service:
  port: 80
```

**`helm/charts/dashboard/templates/deployment.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app.kubernetes.io/name: {{ .Chart.Name }}
    app.kubernetes.io/instance: {{ .Release.Name }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
      app.kubernetes.io/instance: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Chart.Name }}
        app.kubernetes.io/instance: {{ .Release.Name }}
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Values.global.imageTag | default "latest" }}"
          imagePullPolicy: {{ .Values.global.imagePullPolicy | default "IfNotPresent" }}
          ports:
            - containerPort: 80
              protocol: TCP
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 15
            periodSeconds: 10
            failureThreshold: 3
```

**`helm/charts/dashboard/templates/service.yaml`** — same pattern as other services, port 80.

---

## Part 4: Verification

Run all from the **monorepo root** unless noted. No cluster needed for this phase.

### Step 1: Helm dependency update

```bash
helm dependency update helm/vantage-demo
```

Packages each subchart from `helm/charts/` into `helm/vantage-demo/charts/*.tgz` and writes `Chart.lock`. Commit `Chart.lock`. Re-run whenever any subchart's `Chart.yaml` `version` field changes.

### Step 2: Helm lint

```bash
helm lint helm/vantage-demo --with-subcharts --strict
```

Expected: `1 chart(s) linted, 0 chart(s) failed`.

### Step 3: Helm template dry-run

```bash
helm template vantage-demo helm/vantage-demo | kubectl apply --dry-run=client -f -
```

Expected: all resources print `configured (dry run)` with no errors.

If `kubectl` is unavailable:
```bash
helm template vantage-demo helm/vantage-demo > /tmp/rendered.yaml
```
Inspect `rendered.yaml` manually — check that service DNS names in env vars match service names.

### Step 4: Docker builds (Node services)

Build five services from the monorepo root. Dashboard build requires Phase 7 to be complete.

```bash
docker build -f apps/alert-engine/Dockerfile        -t vantage/alert-engine:local .
docker build -f apps/ingestion-service/Dockerfile    -t vantage/ingestion-service:local .
docker build -f apps/telemetry-simulator/Dockerfile  -t vantage/telemetry-simulator:local .
docker build -f apps/event-store-service/Dockerfile  -t vantage/event-store-service:local .
docker build -f apps/api-service/Dockerfile          -t vantage/api-service:local .
```

Common failures and fixes:
- `tsx: not found` → tsx not moved to dependencies in that service's package.json
- `pnpm fetch` error → `pnpm-lock.yaml` not present; must build from monorepo root, not from the app directory
- Any `pnpm install` failure about missing packages → `.dockerignore` may be missing, causing stale `node_modules/` to be included in the build context

### Step 5: Docker build (dashboard — requires Phase 7)

```bash
docker build -f apps/dashboard/Dockerfile -t vantage/dashboard:local .
```

Common failures:
- `ng: not found` → `@angular/cli` missing from `apps/dashboard/package.json`
- `dist/dashboard/browser not found` → `ng build` failed silently; check `angular.json` for project name `"dashboard"` and builder `@angular/build:application`

### Step 6: Smoke-test a Node container

```bash
docker run --rm \
  -e DATABASE_URL=postgresql://vantage:vantage@host.docker.internal:5432/vantage \
  -e API_SERVICE_URL=http://localhost:3004 \
  -p 3002:3002 \
  vantage/alert-engine:local
```

Expected: alert-engine starts, runs migrations, logs `alert-engine ready` on port 3002. Requires docker-compose infra running (`pnpm infra:up`).

### Step 7: Smoke-test the dashboard container

```bash
docker run --rm -p 8080:80 vantage/dashboard:local
```

Open `http://localhost:8080`. The Angular shell must load. API calls will fail (no backend), which is expected.

---

## Part 5: Handover Notes for Phase 9

Phase 9 (Local K3s Deployment) uses `nerdctl` instead of `docker` to build images directly into K3s's containerd namespace. The Dockerfiles and Helm charts are used as-is.

**Build images for K3s:**
```bash
nerdctl --namespace k8s.io build -f apps/alert-engine/Dockerfile -t vantage/alert-engine:local .
# ... repeat for each service
```

**Install nginx-ingress with snippet annotations enabled** (required for WebSocket):
```bash
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical
```

**Deploy the stack:**
```bash
helm install vantage-demo helm/vantage-demo \
  --create-namespace \
  --namespace vantage \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

`imagePullPolicy: Never` tells K3s to use locally-built images rather than pulling from a registry — works because `nerdctl --namespace k8s.io build` places images directly into K3s's containerd store. Note: infra images (postgres, redis, elasticsearch) use `imagePullPolicy: IfNotPresent` hardcoded in their charts — they will be pulled from the public registries, which is correct.
