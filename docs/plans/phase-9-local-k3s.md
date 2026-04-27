---
status: Ready for Implementation
created: 2026-04-27
updated: 2026-04-27
related_docs:
  - docs/plans/roadmap.md
  - docs/plans/phase-8-helm-charts.md
---

# Phase 9: Local K3s Deployment — Implementation Plan

## Context

Phase 9 deploys the complete Vantage stack to a local K3s cluster using Rancher Desktop on Windows. All Dockerfiles and Helm charts were produced in Phase 8. This phase produces no new code — it is a structured operational runbook.

**What success looks like:** `kubectl get pods -n vantage` shows all nine pods Running, a browser at `http://localhost:8080/` (through an nginx-ingress port-forward) shows the Angular dashboard with live device cards, and triggering a scenario causes an alarm to appear in the UI within two seconds without a page refresh.

**Why nginx-ingress is required:** The Angular app uses relative URLs throughout (`/api/devices`, `/ws`). The browser resolves these against whichever host:port serves the dashboard. With port-forward only, those calls hit the dashboard's nginx container, which is a pure static file server — it returns 404 for anything except Angular routes. nginx-ingress is the router that maps `/api/*` and `/ws` to the api-service. Port-forward is used for CLI verification (curl, wscat, metrics); nginx-ingress is required for the browser-based smoke test.

**Phase 8 artefacts required before starting:**
- `apps/*/Dockerfile` — all six service Dockerfiles (confirmed present)
- `helm/charts/*/` — all nine subchart directories (confirmed present)
- `helm/vantage-demo/` — umbrella chart: `Chart.yaml`, `values.yaml`, `values-central.yaml`, `templates/_helpers.tpl`, `templates/ingress.yaml`
- `helm/vantage-demo/Chart.lock` — committed; re-created by `helm dep update`
- `helm/vantage-demo/charts/*.tgz` — gitignored; always absent on fresh clone; re-created by `helm dep update`

---

## Part 1: Rancher Desktop Setup (One-Time)

Rancher Desktop provides K3s, kubectl, helm, and nerdctl on Windows. These steps are done once per machine.

### 1.1 Install Rancher Desktop

Download and install Rancher Desktop from [rancherdesktop.io](https://rancherdesktop.io). The installer bundles kubectl, helm, and nerdctl — no separate installs needed.

After first launch, wait for Kubernetes to start (status bar shows "Kubernetes: Running").

### 1.2 Configure WSL2 Resources

Rancher Desktop on Windows uses **WSL2** (not Lima, which is the macOS backend). WSL2 resource limits are not configured inside Rancher Desktop's UI — they are set via a configuration file that Windows reads before starting any WSL2 distribution.

Create or edit `%USERPROFILE%\.wslconfig` (e.g. `C:\Users\dunca\.wslconfig`):

```ini
[wsl2]
memory=6GB
processors=4
```

Minimum values: `memory=6GB, processors=4`. Recommended: `memory=8GB, processors=6`. Elasticsearch alone allocates 512 MB heap with at least 1 GB JVM footprint; add postgres, Redis, five Node services, and K3s system pods and the total approaches 5 GB under load.

After creating or editing `.wslconfig`, restart WSL2 so the limits apply:

```powershell
# Run in PowerShell (not bash)
wsl --shutdown
```

Then relaunch Rancher Desktop. If pods are OOMKilled during the deployment, this file is the first thing to adjust.

### 1.3 Switch Container Runtime to containerd

**Preferences → Container Engine → General tab → select containerd**

This is required. K3s uses containerd internally. Building images with `nerdctl --namespace k8s.io` places them directly into K3s's image store. With the containerd runtime selected, `nerdctl` and K3s share the same store — no image transfer step is needed.

If the runtime is switched after the cluster was already running, restart the cluster.

### 1.4 Disable Traefik

K3s ships with Traefik as its default ingress controller. It claims port 80. If Traefik is running when nginx-ingress is installed, the nginx-ingress controller will fail to bind port 80.

**Preferences → Kubernetes → uncheck "Enable Traefik"**

If the cluster was already started with Traefik enabled, uncheck the box and restart the cluster.

### 1.5 Install CLI utilities

All commands in this plan use bash (Git Bash or WSL — not PowerShell; the Bash subshell syntax used here is not PowerShell-compatible).

Install these two tools before starting verification:

**jq** (JSON processor — used in every curl verification command):
```bash
# Via winget (run in PowerShell or cmd):
winget install jqlang.jq
```
Restart your terminal after installation — winget updates PATH but the current session does not see the change until a new terminal is opened.

**wscat** (WebSocket client — used in WebSocket verification):
```bash
npm install -g wscat
```

### 1.6 Verify Tooling

Open a new terminal after Rancher Desktop install (so PATH is refreshed):

```bash
kubectl version --client
helm version
nerdctl --version
jq --version
wscat --version
```

All five commands should print version strings. If kubectl/helm/nerdctl are not found, check Preferences → Application → PATH Management → Automatic.

---

## Part 2: Pre-Flight Checks

Run these from the monorepo root before building images.

### 2.1 Helm dependency update

The `.tgz` subchart archives in `helm/vantage-demo/charts/` are gitignored and are always absent on a fresh clone. `helm install` reads from those archives. Run this on every fresh clone and whenever any subchart `Chart.yaml` version field changes:

```bash
helm dependency update helm/vantage-demo
```

This packs each subchart from `helm/charts/` into `helm/vantage-demo/charts/*.tgz` and writes `Chart.lock`. `Chart.lock` is committed; the `.tgz` files are not.

### 2.2 Helm lint

```bash
helm lint helm/vantage-demo --with-subcharts --strict
```

Expected: `1 chart(s) linted, 0 chart(s) failed`. Fix any errors before proceeding — a lint failure means template rendering will fail at deploy time.

### 2.3 Confirm K3s is healthy

```bash
kubectl get nodes
kubectl get pods -A
```

Expected: one node with STATUS `Ready`, system pods (coredns, local-path-provisioner, metrics-server) Running, and no Traefik pods.

---

## Part 3: Build Service Images

All builds use the **monorepo root as build context** and target K3s's containerd namespace via `--namespace k8s.io`. This places images directly in the store K3s pulls from — no registry push, no `nerdctl load`.

Use bash. Run from the repository root.

**Build order and timing:** The dashboard build takes the longest (~5 min first run, ~1 min with cache) because it runs `ng build`. Start it first, then run the Node services sequentially in the same terminal or in parallel across multiple terminal windows to save time (~20 min sequential, ~5 min if all six run in parallel).

```bash
# Start the longest build first
nerdctl --namespace k8s.io build \
  -f apps/dashboard/Dockerfile \
  -t vantage/dashboard:local \
  .

# Node services — can run in parallel in separate terminals (~2-3 min each first run)
nerdctl --namespace k8s.io build \
  -f apps/alert-engine/Dockerfile \
  -t vantage/alert-engine:local \
  .

nerdctl --namespace k8s.io build \
  -f apps/ingestion-service/Dockerfile \
  -t vantage/ingestion-service:local \
  .

nerdctl --namespace k8s.io build \
  -f apps/telemetry-simulator/Dockerfile \
  -t vantage/telemetry-simulator:local \
  .

nerdctl --namespace k8s.io build \
  -f apps/event-store-service/Dockerfile \
  -t vantage/event-store-service:local \
  .

nerdctl --namespace k8s.io build \
  -f apps/api-service/Dockerfile \
  -t vantage/api-service:local \
  .
```

**Verify images are in K3s's store:**

```bash
nerdctl --namespace k8s.io images | grep vantage
```

Expected: six `vantage/*:local` images. If any are missing, re-run that specific build.

**Common build failures:**

| Error | Cause | Fix |
|-------|-------|-----|
| `tsx: not found` at container start | tsx in devDependencies, stripped by pnpm deploy | Move tsx to dependencies in that service's package.json, rebuild |
| `ng: not found` during dashboard build | @angular/cli not in apps/dashboard/package.json | Check package.json and pnpm-lock.yaml |
| `pnpm fetch: lockfile not found` | Build not running from monorepo root | Run from repo root, not from inside apps/ |
| Context upload takes minutes | .dockerignore missing or not effective | Confirm .dockerignore at repo root excludes `**/node_modules` |
| `COPY apps/dashboard/package.json: no such file` | Phase 7 not complete | Complete Phase 7 first |

---

## Part 4: Deploy the Stack

### 4.1 Create namespace

```bash
kubectl create namespace vantage
```

### 4.2 Install nginx-ingress

nginx-ingress must be installed before the umbrella chart so the `Ingress` resource the chart creates has a controller to satisfy it. The two flags below are both required for WebSocket support via the `configuration-snippet` annotation.

**Note on maintenance status:** `kubernetes/ingress-nginx` reached end-of-life in March 2026 and receives no further releases or security patches. It remains fully functional for a local demo. For Phase 12 (EC2 production deployment), consider using Traefik (which K3s ships with by default) instead — that would require changing `ingressClassName: nginx` to `ingressClassName: traefik` in `helm/vantage-demo/templates/ingress.yaml` and removing the `configuration-snippet` annotation (Traefik handles WebSocket natively). That is a Phase 12 decision; for local K3s this chart is used as-is.

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical
```

**Why both flags:** `allowSnippetAnnotations=true` enables snippet annotations. `annotations-risk-level=Critical` is required from nginx-ingress v1.10+ — without it, `configuration-snippet` is silently ignored even when snippets are enabled (it is classified `Critical` risk and filtered at the default `High` level). The result of missing the second flag is that WebSocket connections are established but immediately dropped, with no error logged.

Wait for the controller to be ready before proceeding:

```bash
kubectl get pods -n ingress-nginx -w
```

Expected: `ingress-nginx-controller-*` pod Running within ~60 seconds. Press Ctrl-C when Running.

**Important — port exposure on Windows:** On Rancher Desktop (WSL2), LoadBalancer services are **not** forwarded to the Windows host. K3s's ServiceLB uses `hostPort` inside WSL2, which WSL2 does not relay outward. This means `http://localhost/` will not work from a Windows browser. The fix is to port-forward the controller's service itself — this is done in Part 6 before the browser smoke test.

### 4.3 Install the umbrella chart

```bash
helm install vantage-demo helm/vantage-demo \
  --namespace vantage \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

`global.imageTag=local` causes all six service deployments to use the `vantage/*:local` images built in Part 3.

`global.imagePullPolicy=Never` tells K3s not to attempt a registry pull — it uses only what is already in the local containerd store. This applies only to `vantage/*` service images. Infrastructure images (postgres, redis, elasticsearch) have `imagePullPolicy: IfNotPresent` hardcoded in their charts and are pulled from public registries on first deploy.

**Expected output:**
```
NAME: vantage-demo
LAST DEPLOYED: ...
NAMESPACE: vantage
STATUS: deployed
```

### 4.4 Watch startup

```bash
kubectl get pods -n vantage -w
```

**Expected startup sequence and timing:**

| Pod | Typical ready time | Notes |
|-----|--------------------|-------|
| vantage-demo-redis | ~15s | Readiness probe: redis-cli ping |
| vantage-demo-dashboard | ~15s | Static nginx, no deps |
| vantage-demo-telemetry-simulator | ~20s | No external deps at startup |
| vantage-demo-postgres | ~30s | Readiness probe: pg_isready |
| vantage-demo-ingestion-service | ~30s | Needs Redis |
| vantage-demo-alert-engine | After postgres | Runs DB migrations on startup; may CrashLoopBackOff 1-2× waiting for postgres — expected |
| vantage-demo-api-service | ~15s | `/health` has no external checks; starts cleanly regardless of postgres/ES readiness |
| vantage-demo-elasticsearch | 2–4 min | initContainer sets vm.max_map_count first; large readiness initialDelay |
| vantage-demo-event-store-service | After ES | Calls bootstrapIndex() at startup; exits if ES unreachable; may CrashLoopBackOff 3-6× until ES is ready — expected |

Total time from `helm install` to all pods Running: **5–8 minutes** on first deploy (Elasticsearch dominates). Image pull time for public registry images (postgres, redis, ES) adds to this on first run.

Press Ctrl-C once all pods show Running. Then confirm the final state:

```bash
kubectl get pods -n vantage
```

All nine pods should show `STATUS: Running` and `READY: 1/1`. If any remain in `CrashLoopBackOff` after 10 minutes, go to the Troubleshooting section.

---

## Part 5: Backend Verification (Port-forward)

Port-forward verifies the API and backend services directly without requiring the browser. This covers the data store and business logic paths.

Open two terminals and leave these running throughout Part 5:

```bash
# Terminal A — API service
kubectl port-forward -n vantage svc/vantage-demo-api-service 3004:3004

# Terminal B — alert-engine metrics
kubectl port-forward -n vantage svc/vantage-demo-alert-engine 3002:3002
```

### 5.1 REST endpoint smoke test

```bash
# Device state — three devices: PM-01, PM-02, RIID-01
curl -s http://localhost:3004/api/devices | jq .

# Alarm list — empty initially
curl -s http://localhost:3004/api/alarms | jq .

# Event search — Elasticsearch-backed
curl -s "http://localhost:3004/api/events/search?from=now-5m&to=now" | jq .
```

Expected: `/api/devices` returns three device state objects within a few seconds of the telemetry-simulator starting. `/api/alarms` returns `{ total: 0, alarms: [] }`. The event search may be empty if the simulator has not yet run.

### 5.2 WebSocket + end-to-end alarm trigger

```bash
# Open WebSocket connection (leave this running)
wscat -c ws://localhost:3004/ws
```

With the wscat connection open, trigger a scenario in a separate terminal:

```bash
curl -X POST http://localhost:3004/api/scenarios/norm-threshold
```

Expected within 2 seconds: wscat receives a JSON alarm message (`{ "type": "alarm", "alarm": { ... } }`).

Confirm the alarm was persisted:

```bash
curl -s http://localhost:3004/api/alarms | jq '.alarms[0]'
```

Expected: alarm record with `alarmSubtype: "NORM_THRESHOLD"`.

### 5.3 Acknowledge an alarm

```bash
ALARM_ID=$(curl -s http://localhost:3004/api/alarms | jq -r '.alarms[0].id')
curl -s -X PATCH "http://localhost:3004/api/alarms/${ALARM_ID}/acknowledge" | jq .
```

Expected: response includes the acknowledged alarm; a subsequent `GET /api/alarms?status=ACTIVE` no longer returns it.

### 5.4 Event indexing verification

```bash
# Allow 10s for event-store-service to index, then:
curl -s "http://localhost:3004/api/events/search?from=now-10m&to=now" | jq '.total'
```

Expected: non-zero total. If zero, check event-store-service logs:

```bash
kubectl logs -n vantage deployment/vantage-demo-event-store-service --tail=50
```

### 5.5 Metrics spot-check

```bash
curl -s http://localhost:3002/metrics | grep alert_engine_evaluate
```

Expected: Prometheus text format with `alert_engine_evaluate_duration_seconds_bucket` lines.

---

## Part 6: Browser Dashboard Verification (via nginx-ingress)

nginx-ingress was installed in Part 4.2. The umbrella chart's `ingress.yaml` routes:
- `/api/*` → api-service
- `/ws` → api-service
- `/` → dashboard

**Port-forward required on Windows:** On Rancher Desktop (WSL2), the nginx-ingress controller's LoadBalancer service port 80 is not forwarded to the Windows host. The fix is to port-forward the controller's ClusterIP service directly. This keeps the ingress routing layer intact — the controller still proxies `/api/*`, `/ws`, and `/` correctly — but makes it reachable from a Windows browser.

Open a dedicated terminal and leave it running throughout Part 6:

```bash
# Terminal C — nginx-ingress controller
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80
```

All browser and curl references in this section use `http://localhost:8080`. Angular's WebSocket service constructs its URL from `window.location.host`, which will be `localhost:8080` — so `ws://localhost:8080/ws` routes through the controller correctly.

### 6.1 Confirm ingress resource exists

```bash
kubectl get ingress -n vantage
```

Expected: `vantage-demo-ingress` is listed. ADDRESS may be empty on Rancher Desktop — this is normal when using port-forward rather than direct host-port binding; the ingress resource still functions.

### 6.2 Dashboard load

Open `http://localhost:8080/` in a browser.

Expected:
- Angular app loads (no blank page, no 502/404)
- Live Operations view shows three device status cards (PM-01, PM-02, RIID-01)
- Device cards show last-seen timestamps that update every ~10 seconds
- Online device count reflects three active devices
- Active Alarms panel is empty (or shows any previously triggered alarms)

If the page loads but device cards are missing after 10 seconds, open browser DevTools → Network tab. API calls to `/api/devices` should return 200. If they return 502 or ECONNREFUSED, check that api-service is Running and that the Ingress backend service name matches (`vantage-demo-api-service`).

### 6.3 End-to-end browser smoke test

1. Open `http://localhost:8080/` in the browser
2. In a terminal, trigger a scenario:
   ```bash
   curl -X POST http://localhost:8080/api/scenarios/norm-threshold
   ```
3. Observe the browser: a new alarm card should animate into the Active Alarms panel **within 2 seconds** without a page refresh
4. Click **Acknowledge** on the alarm card — it should disappear from the Active Alarms panel immediately

Trigger all three scenarios to exercise the full alarm path:

```bash
curl -X POST http://localhost:8080/api/scenarios/norm-threshold
curl -X POST http://localhost:8080/api/scenarios/isotope-identified
curl -X POST http://localhost:8080/api/scenarios/concurrent
```

### 6.4 Event Search view

Navigate to the Detection Event Search view at `http://localhost:8080/`. Search for events in the last 10 minutes. Results should appear in the table. If the table is empty, trigger another scenario and wait 10 seconds for Elasticsearch indexing.

### 6.5 Alarm History view

Navigate to the Alarm History view. All previously triggered alarms (including acknowledged ones) should appear in the paginated table.

---

## Part 7: Update Workflow (After Code Changes)

When service code changes after the initial deploy, rebuild the affected image and trigger a rolling restart. Helm does not detect image content changes when the tag is unchanged.

```bash
# Rebuild the changed service (example: alert-engine)
nerdctl --namespace k8s.io build \
  -f apps/alert-engine/Dockerfile \
  -t vantage/alert-engine:local \
  .

# Rolling restart — K8s pulls the new image from the local containerd store
kubectl rollout restart deployment/vantage-demo-alert-engine -n vantage

# Watch the rollout
kubectl rollout status deployment/vantage-demo-alert-engine -n vantage
```

**After the rollout completes, restart port-forward sessions.** `kubectl rollout restart` replaces the old pod; any `kubectl port-forward` is bound to the old pod's network namespace and dies when it terminates. Ctrl-C each terminal from Parts 5 and 6 and re-run the same port-forward commands.

For Helm values changes only (no image rebuild):

```bash
helm upgrade vantage-demo helm/vantage-demo \
  --namespace vantage \
  --reuse-values \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

---

## Part 8: Teardown and Reset

### Full teardown

```bash
# Uninstall the release (does NOT delete PVCs — helm.sh/resource-policy: keep)
helm uninstall vantage-demo -n vantage

# Delete PVCs explicitly (wipes postgres, redis, elasticsearch data)
kubectl delete pvc -n vantage --all

# Optionally delete the namespace
kubectl delete namespace vantage
```

nginx-ingress is installed separately and survives `helm uninstall vantage-demo`. To also remove it:

```bash
helm uninstall ingress-nginx -n ingress-nginx
kubectl delete namespace ingress-nginx
```

### Clean images from K3s store

```bash
nerdctl --namespace k8s.io rmi \
  vantage/alert-engine:local \
  vantage/ingestion-service:local \
  vantage/telemetry-simulator:local \
  vantage/event-store-service:local \
  vantage/api-service:local \
  vantage/dashboard:local
```

### Re-deploy after teardown

```bash
kubectl create namespace vantage

# nginx-ingress persists if not removed; re-install only if it was removed
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical

helm install vantage-demo helm/vantage-demo \
  --namespace vantage \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

---

## Troubleshooting

### Pod stuck in Pending

```bash
kubectl describe pod <pod-name> -n vantage
```

**PVC not bound:** The local-path provisioner creates PVCs on demand. If it shows `waiting for a volume to be created`, wait 30 seconds. If still pending after 2 minutes:
```bash
kubectl get pods -n kube-system | grep local-path
kubectl logs -n kube-system deployment/local-path-provisioner
```

**Insufficient resources:** If the event is `Insufficient memory`, increase Rancher Desktop VM memory and restart.

### Pod CrashLoopBackOff

```bash
kubectl logs -n vantage deployment/<name> --previous
```

**alert-engine crashes on startup:** It runs DB migrations. If postgres isn't ready yet, it crashes and K8s restarts it. This self-resolves within 2–3 restart cycles once postgres passes its readiness probe. api-service does not run migrations and its `/health` endpoint has no external dependency checks — it starts cleanly in ~15s regardless of postgres/ES state. If api-service shows CrashLoopBackOff, check for a missing env var via `kubectl describe pod <pod-name> -n vantage`.

**`tsx: not found`:** tsx is in devDependencies for that service, stripped by `pnpm deploy --prod`. Move tsx to dependencies in that service's `package.json` and rebuild the image.

**`ECONNREFUSED` to redis:** The service started before Redis. Wait — K8s will restart it and Redis will be ready shortly.

**event-store-service exits immediately:** It calls `bootstrapIndex()` at startup, which fails if Elasticsearch is not yet responding. It will CrashLoopBackOff until ES passes its readiness probe (~2–4 min). This is expected — wait it out.

### Elasticsearch stuck in Init or CrashLoopBackOff

```bash
kubectl logs -n vantage statefulset/vantage-demo-elasticsearch -c increase-vm-max-map
kubectl logs -n vantage statefulset/vantage-demo-elasticsearch -c elasticsearch
```

**initContainer fails with permission denied on sysctl:** Confirm `statefulset.yaml` has `securityContext.privileged: true` and `runAsUser: 0` on the initContainer.

**OOMKilled:** ES hit its memory limit. Raise `elasticsearch.resources.limits.memory` (minimum `1536Mi`) or deploy with `values-central.yaml` (which sets 2Gi):
```bash
helm upgrade vantage-demo helm/vantage-demo \
  --namespace vantage \
  -f helm/vantage-demo/values-central.yaml \
  --set global.imageTag=local \
  --set global.imagePullPolicy=Never
```

**`vm.max_map_count` too low in ES logs:** The initContainer did not run. Check `kubectl describe statefulset/vantage-demo-elasticsearch -n vantage` for admission errors related to `privileged: true`.

### nginx-ingress: WebSocket connects but drops immediately

The `configuration-snippet` annotation is being ignored. Confirm nginx-ingress was installed with both flags:
```bash
helm get values ingress-nginx -n ingress-nginx
```

The output is a nested YAML tree — look for these keys:
```yaml
controller:
  allowSnippetAnnotations: true
  config:
    annotations-risk-level: Critical
```
Or grep for them: `helm get values ingress-nginx -n ingress-nginx | grep -E 'allowSnippet|annotations-risk'`. If either is missing, upgrade nginx-ingress:
```bash
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --set controller.allowSnippetAnnotations=true \
  --set controller.config.annotations-risk-level=Critical
```

### Browser shows device cards but no alarm on scenario trigger

The alarm path has five hops. Work backwards from the symptoms:

1. **Alarm in postgres but not in browser:** api-service received the notify call but the WebSocket broadcast failed. Check:
   ```bash
   kubectl logs -n vantage deployment/vantage-demo-api-service --tail=30
   ```

2. **Alarm in postgres, api-service got the notify, but browser still shows nothing:** WebSocket connection was dropped. Reload the browser and re-connect.

3. **No alarm in postgres:** alert-engine did not evaluate or write the alarm. Check:
   ```bash
   kubectl logs -n vantage deployment/vantage-demo-alert-engine --tail=30
   ```

4. **alert-engine logs show it received no event:** ingestion-service did not forward to alert-engine. Check:
   ```bash
   kubectl logs -n vantage deployment/vantage-demo-ingestion-service --tail=30
   ```

5. **No events in ingestion-service:** telemetry-simulator did not send events. Check:
   ```bash
   kubectl logs -n vantage deployment/vantage-demo-telemetry-simulator --tail=30
   ```

### Dashboard shows blank page or 502

```bash
kubectl get ingress -n vantage
kubectl describe ingress vantage-demo-ingress -n vantage
```

**502 Bad Gateway:** The backend service is not ready. Confirm `vantage-demo-dashboard` pod is Running.

**Browser cannot connect (connection refused on localhost:8080):** The nginx-ingress controller port-forward (Terminal C from Part 6) is not running. Restart it:
```bash
kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80
```

**nginx-ingress controller not running:** Check:
```bash
kubectl get pods -n ingress-nginx
```

**Angular routes return 404 on refresh:** The nginx.conf is missing the `try_files $uri $uri/ /index.html` fallback. Confirm `apps/dashboard/nginx.conf` has that directive and rebuild the dashboard image.

---

## Definition of Done

Phase 9 is complete when all of the following are true:

**Backend (via port-forward):**
- [ ] `kubectl get pods -n vantage` — all nine pods `Running 1/1`
- [ ] `curl http://localhost:3004/api/devices` — returns three device state objects
- [ ] `curl http://localhost:3004/api/events/search?from=now-10m&to=now` — non-zero total after simulator has run ~30s
- [ ] `wscat -c ws://localhost:3004/ws` then `curl -X POST http://localhost:3004/api/scenarios/norm-threshold` — alarm message received in wscat within 2 seconds

**Browser dashboard (via nginx-ingress at `http://localhost:8080/`):**
- [ ] Angular app loads with three device status cards and online device count
- [ ] Triggering a scenario causes an alarm to appear in Active Alarms panel within 2 seconds without page refresh
- [ ] Acknowledging an alarm via the UI removes it from the Active Alarms panel
- [ ] Detection Event Search returns results
- [ ] Alarm History shows historical alarms including acknowledged ones
