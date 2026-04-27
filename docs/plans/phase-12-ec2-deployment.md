---
status: Draft
created: 2026-04-27
updated: 2026-04-27
related_docs:
  - docs/plans/roadmap.md
  - docs/plans/phase-8-helm-charts.md
  - docs/plans/phase-9-local-k3s.md
  - docs/plans/phase-11-cicd.md
---

# Phase 12: EC2 Deployment — Implementation Plan

## Context

All six services are built, containerised, and deployed to local K3s (Phase 9). Grafana dashboards are live (Phase 10). CI/CD pipelines are written and CI-verified (Phase 11). The GitHub repository is already public. Phase 12 provisions the EC2 instance, performs the one-time OS and K3s setup, makes a small change to the Helm ingress chart to use Traefik (replacing nginx-ingress), adds a WebSocket heartbeat to api-service, wires the GitHub Actions deploy pipeline to EC2, and does a final end-to-end smoke test including Grafana.

**What success looks like:** a push to `main` on GitHub causes `deploy.yml` to automatically build images, push them to `ghcr.io`, SSH to EC2, and run `helm upgrade`. The Vantage dashboard is accessible at a public IP address. Triggering a scenario produces an alarm in the browser UI within two seconds. Grafana dashboards load and display live data.

**Phase 11 corrections required:**
- `helm upgrade` in `deploy.yml` is missing `--namespace vantage --create-namespace`
- `helm upgrade` in `deploy.yml` is missing `--set grafana.adminPassword=...` (planned in Phase 10, implemented here)
- Both fixed in Part 1.

---

## Execution Sequence

The parts of this plan are not executed in order 1→7. Follow this sequence:

```
Part 1 (code changes) → git push main → wait for build-and-push to complete
  → Part 2 (AWS provisioning) → Part 3 (EC2 setup) → Part 4 (first manual deploy)
  → Part 5 (CI/CD wiring) → Part 6 (optional TLS) → Part 7 (README)
```

**Why push before provisioning:** `deploy.yml`'s `build-and-push` job creates the `ghcr.io` images tagged `:latest`. The first manual deploy (Part 4) needs those images. The `deploy` job will fail with an SSH error (EC2 doesn't exist yet) — that is expected and harmless. Provision EC2 after the `build-and-push` job shows green.

---

## Design Decisions

### Why Traefik instead of nginx-ingress?

`kubernetes/ingress-nginx` reached end-of-life in March 2026. K3s ships Traefik v3 by default. Switching to Traefik requires changing one field in the Ingress resource and removing two nginx-specific annotations. Traefik handles WebSocket natively — the `configuration-snippet` annotation that was required for nginx-ingress is unnecessary.

**This change breaks local K3s.** The Phase 9 local environment uses nginx-ingress with Traefik disabled. After committing this change, `helm upgrade` on local K3s will produce silent routing failures (no controller satisfies `ingressClassName: traefik`). Since Phase 12 is the final phase and local K3s development is complete, this breakage is accepted.

### Traefik WebSocket idle timeout

Traefik v3's default backend idle timeout is 60 seconds. nginx-ingress was configured at 3600 seconds for long-lived WebSocket connections. Without mitigation, a WebSocket idle for >60 seconds is dropped by Traefik, causing the operator to silently miss the next alarm. The fix is a 30-second server-side ping in api-service — simpler than any Traefik middleware configuration and unconditionally correct. This is added in Part 1.

### Grafana admin password

`helm/vantage-demo/values.yaml` sets `adminPassword: vantage` for local development. Phase 10 explicitly specified that EC2 production deploys override this via `--set grafana.adminPassword=$GRAFANA_ADMIN_PASSWORD`, where the value comes from a GitHub Actions secret. The manual first deploy (Part 4) uses the `vantage` default from `values.yaml`. Automated deploys (Part 5) use the GitHub secret. Credentials for the manual deploy: `admin` / `vantage`.

### Why t3.large?

The local Elasticsearch chart (`helm/charts/elasticsearch/values.yaml`) already sets `javaOpts: "-Xms512m -Xmx512m"` and a hard `memory: "1Gi"` limit. Elasticsearch's footprint is therefore bounded at ~1 GB regardless of host RAM — no `extraEnvVars` override needed in `values-production.yaml`. The remaining consumers (K3s control plane ~500 MB, six Node.js services ~1.5 GB, PostgreSQL ~256 MB, Redis ~64 MB, Prometheus ~256 MB, Grafana ~256 MB, OS ~512 MB) sum to ~4.3 GB, well within the t3.large's 8 GB. A t3.xlarge (16 GB) would leave ~11 GB idle. A t3.medium (4 GB) is too tight for the control plane plus all services. t3.large is the correct size.

### Why 50 GB root EBS?

The `t3.large` default root volume is 8 GB. Container images for six application services plus three infrastructure services (PostgreSQL, Redis, Elasticsearch) occupy ~5–6 GB. K3s and the containerd image store need headroom on top of that. Elasticsearch's data directory lives on the root filesystem until a PVC is bound by the local-path provisioner, and its JVM start is slow if the filesystem is near capacity. 50 GB provides sufficient headroom for the demo lifetime with no storage class configuration required.

### Why disable firewalld?

Rocky Linux 9 enables `firewalld` by default. K3s manages iptables/nftables rules directly and conflicts with firewalld's routing. The EC2 security group is the appropriate security boundary for this deployment.

### Why `K3S_KUBECONFIG_MODE=644`?

K3s writes `/etc/rancher/k3s/k3s.yaml` owned by root with `600` permissions. Setting mode `644` at install time allows the `rocky` user to run `kubectl` and `helm` without `sudo`.

### KUBECONFIG for interactive vs. automated sessions

`~/.bash_profile` is sourced for interactive login shells (your personal SSH sessions). `ssh user@host "command"` starts a non-interactive, non-login shell on most OpenSSH configurations — neither file is sourced. Setting `KUBECONFIG` in `~/.bash_profile` covers interactive use. The inline `export KUBECONFIG=...` prepended to the `deploy.yml` SSH command covers the GitHub Actions case.

---

## Part 1: Code Changes

Three changes — commit together before the first `git push`.

### 1.1 Update `helm/vantage-demo/templates/ingress.yaml` — switch to Traefik

Remove all `nginx.ingress.kubernetes.io/` annotations and change `ingressClassName`. Replace:

```yaml
# Before
metadata:
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
spec:
  ingressClassName: nginx
```

With:

```yaml
# After — Traefik handles WebSocket natively; no annotations needed
spec:
  ingressClassName: traefik
```

Remove the `annotations` block entirely if it contained only nginx annotations. If cert-manager annotations are added later (Part 6), they go back here.

Run `helm lint helm/vantage-demo --with-subcharts --strict` — expected: `1 chart(s) linted, 0 chart(s) failed`.

### 1.2 Fix `.github/workflows/deploy.yml`

Three changes to the deploy SSH command:

- Prepend `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml;` — required for the non-interactive SSH session to find the cluster
- Add `--namespace vantage --create-namespace` — Phase 11 omitted this
- Add `--set grafana.adminPassword=${{ secrets.GRAFANA_ADMIN_PASSWORD }}` — planned in Phase 10, implemented here

```bash
# Before (Phase 11 as-written)
ssh -i ~/.ssh/ec2-key rocky@${{ secrets.EC2_HOST }} \
  "cd /opt/vantage-demo && \
   git pull origin main && \
   helm dependency build helm/vantage-demo && \
   helm upgrade --install vantage-demo helm/vantage-demo \
     --values helm/vantage-demo/values-production.yaml \
     --set global.imageTag=sha-${{ github.event.workflow_run.head_sha }} \
     --wait --timeout 10m"

# After
ssh -i ~/.ssh/ec2-key rocky@${{ secrets.EC2_HOST }} \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   cd /opt/vantage-demo && \
   git pull origin main && \
   helm dependency build helm/vantage-demo && \
   helm upgrade --install vantage-demo helm/vantage-demo \
     --namespace vantage \
     --create-namespace \
     --values helm/vantage-demo/values-production.yaml \
     --set global.imageTag=sha-${{ github.event.workflow_run.head_sha }} \
     --set grafana.adminPassword=${{ secrets.GRAFANA_ADMIN_PASSWORD }} \
     --wait --timeout 10m"
```

### 1.3 Add WebSocket heartbeat to api-service

Traefik drops idle WebSocket connections after 60 seconds. Locate the WebSocket server setup in `apps/api-service/src/` — wherever `new WebSocket.Server(...)` is called and `wss` is assigned. Add a 30-second ping interval immediately after:

```typescript
// Prevent Traefik's 60-second idle timeout from dropping silent connections.
// Ping all connected clients every 30s; browsers respond with a pong automatically.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  });
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));
```

This is a safe addition regardless of what the Angular client does. Browsers handle the `ping` frame automatically.

### 1.4 Commit and push

```bash
git add helm/vantage-demo/templates/ingress.yaml \
        .github/workflows/deploy.yml \
        apps/api-service/src/
git commit -m "Phase 12: Traefik ingress, deploy namespace, WS heartbeat"
git push origin main
```

On GitHub, navigate to **Actions → Deploy**. Wait for the `build-and-push` matrix job to go green (all six images pushed to `ghcr.io`). The `deploy` job that follows will fail with an SSH error — this is expected since EC2 does not exist yet. Once `build-and-push` is green, proceed to Part 2.

---

## Part 2: AWS Infrastructure Provisioning

Run from any machine with the AWS CLI configured (`ec2:*` permissions). All commands target `us-east-1` — substitute your preferred region throughout.

### 2.1 Generate and import SSH key pair

```bash
ssh-keygen -t ed25519 -C "vantage-deploy" -f ~/.ssh/vantage-deploy -N ""
```

Import the public key to EC2:

```bash
aws ec2 import-key-pair \
  --key-name vantage-deploy \
  --public-key-material fileb://~/.ssh/vantage-deploy.pub \
  --region us-east-1
```

This same key is used for both personal SSH access and the GitHub Actions deploy — acceptable for a one-week demo.

### 2.2 Create security group

```bash
SG_ID=$(aws ec2 create-security-group \
  --group-name vantage-demo \
  --description "Vantage Demo — HTTP + HTTPS + SSH" \
  --query "GroupId" \
  --output text \
  --region us-east-1)

echo "Security group: $SG_ID"
```

Add inbound rules:

```bash
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0 \
  --region us-east-1

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 80 --cidr 0.0.0.0/0 \
  --region us-east-1

# HTTPS — required for ACME HTTP-01 challenge if TLS is added later
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 443 --cidr 0.0.0.0/0 \
  --region us-east-1
```

### 2.3 Find Rocky Linux 9 AMI

Rocky Linux is published by the Rocky Enterprise Software Foundation (RESF), AWS publisher ID `679593333241`:

```bash
AMI_ID=$(aws ec2 describe-images \
  --owners 679593333241 \
  --filters \
    "Name=name,Values=Rocky-9-EC2-Base-9.*-x86_64*" \
    "Name=state,Values=available" \
    "Name=architecture,Values=x86_64" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text \
  --region us-east-1)

echo "Rocky Linux 9 AMI: $AMI_ID"
```

Verify:

```bash
aws ec2 describe-images \
  --image-ids "$AMI_ID" \
  --query "Images[0].{Name:Name,CreationDate:CreationDate}" \
  --output table \
  --region us-east-1
```

If no result, try a broader filter:

```bash
aws ec2 describe-images \
  --owners 679593333241 \
  --filters "Name=name,Values=Rocky-9*x86_64*" "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-5:].{Name:Name,ImageId:ImageId}" \
  --output table \
  --region us-east-1
```

### 2.4 Launch the instance

```bash
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type t3.large \
  --key-name vantage-deploy \
  --security-group-ids "$SG_ID" \
  --block-device-mappings '[{
    "DeviceName": "/dev/sda1",
    "Ebs": {
      "VolumeSize": 50,
      "VolumeType": "gp3",
      "DeleteOnTermination": true
    }
  }]' \
  --tag-specifications '[{
    "ResourceType": "instance",
    "Tags": [{"Key": "Name", "Value": "vantage-demo"}]
  }]' \
  --query "Instances[0].InstanceId" \
  --output text \
  --region us-east-1)

echo "Instance ID: $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region us-east-1
echo "Instance is running"
```

### 2.5 Allocate and associate an Elastic IP

```bash
ALLOC_ID=$(aws ec2 allocate-address \
  --domain vpc \
  --tag-specifications '[{"ResourceType":"elastic-ip","Tags":[{"Key":"Name","Value":"vantage-demo"}]}]' \
  --query "AllocationId" \
  --output text \
  --region us-east-1)

EIP=$(aws ec2 describe-addresses \
  --allocation-ids "$ALLOC_ID" \
  --query "Addresses[0].PublicIp" \
  --output text \
  --region us-east-1)

echo "Elastic IP: $EIP"

aws ec2 associate-address \
  --instance-id "$INSTANCE_ID" \
  --allocation-id "$ALLOC_ID" \
  --region us-east-1
```

Save `$EIP` durably so it survives terminal restarts:

```bash
echo "export EIP=$EIP" >> ~/.bash_profile && source ~/.bash_profile
```

`$EIP` is the value of the `EC2_HOST` GitHub Actions secret.

### 2.6 Verify SSH access

```bash
# Wait ~90 seconds for boot + cloud-init
ssh -i ~/.ssh/vantage-deploy rocky@$EIP "cat /etc/rocky-release"
```

Expected: `Rocky Linux release 9.x (Blue Onyx)`. If refused, wait 30 more seconds and retry.

---

## Part 3: EC2 One-Time Setup

SSH into the instance for all commands in this section:

```bash
ssh -i ~/.ssh/vantage-deploy rocky@$EIP
```

### 3.1 Update and install utilities

```bash
sudo dnf install -y dnf-utils jq git
sudo dnf update -y
```

`dnf-utils` must be installed first — it provides `needs-restarting`, used in the next step.

**Check whether the kernel was updated and reboot if so:**

```bash
sudo dnf needs-restarting -r
```

Exit code 0 = no reboot needed. Exit code 1 = reboot required. If reboot required:

```bash
sudo reboot
# Reconnect after ~30 seconds:
ssh -i ~/.ssh/vantage-deploy rocky@$EIP
```

K3s installs kernel modules at startup. Installing K3s while an updated kernel is installed but not yet running causes intermittent networking failures.

### 3.2 Disable firewalld

```bash
sudo systemctl disable --now firewalld
```

EC2 security groups are the network boundary. K3s manages its own iptables/nftables rules and conflicts with firewalld.

### 3.3 Install K3s

```bash
curl -sfL https://get.k3s.io | K3S_KUBECONFIG_MODE="644" sh -
```

K3s's install script handles the SELinux policy for Rocky Linux automatically. Wait for K3s to start:

```bash
sudo systemctl status k3s --no-pager
/usr/local/bin/kubectl get nodes
```

Expected: one node with `STATUS: Ready`. K3s installs `kubectl` at `/usr/local/bin/kubectl`.

Confirm Traefik is running (K3s ships it by default):

```bash
/usr/local/bin/kubectl get pods -A | grep traefik
```

Expected: one `traefik-*` pod in `kube-system`, STATUS `Running`.

### 3.4 Set KUBECONFIG for interactive sessions

```bash
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bash_profile
source ~/.bash_profile
kubectl get nodes
```

This covers interactive terminal sessions. The automated deploy.yml covers itself with the inline `export KUBECONFIG=...` prefix (added in Part 1.2).

### 3.5 Install Helm

```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

Expected: `version.BuildInfo{Version:"v3.x.x", ...}`.

### 3.6 Clone the repository

```bash
sudo git clone https://github.com/ApeOnFire/REPO_NAME /opt/vantage-demo
sudo chown -R rocky:rocky /opt/vantage-demo
```

Replace `REPO_NAME` with the actual repository name.

### 3.7 Build Helm dependencies

```bash
cd /opt/vantage-demo
helm dependency build helm/vantage-demo
```

`Chart.lock` is committed. `helm dependency build` reads it and downloads the `.tgz` archives without needing `helm repo add`. These files are gitignored but persist on the filesystem across `git pull` invocations — subsequent deploys use the cached archives.

---

## Part 4: First Manual Deploy

Done before wiring CI/CD. Verifies the stack works on this EC2 instance with the production image registry before handing control to the automated pipeline.

### 4.1 Create namespace and deploy

Run from your local machine (where `$EIP` is set):

```bash
kubectl create namespace vantage
```

Wait — the above needs port-forward or direct kubectl access to the cluster. The manual deploy runs the helm command **on EC2** via SSH, not locally:

```bash
ssh -i ~/.ssh/vantage-deploy rocky@$EIP \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   kubectl create namespace vantage; \
   helm install vantage-demo /opt/vantage-demo/helm/vantage-demo \
     --namespace vantage \
     --values /opt/vantage-demo/helm/vantage-demo/values-production.yaml \
     --set global.imageTag=latest \
     --set grafana.adminPassword=vantage"
```

`global.imageTag=latest` uses the images pushed by `build-and-push` in Part 1.4. `grafana.adminPassword=vantage` matches `values.yaml`'s local dev default — set it explicitly here to confirm the override mechanism works. Automated deploys will use a stronger password from the GitHub secret.

### 4.2 Watch startup

```bash
ssh -i ~/.ssh/vantage-deploy rocky@$EIP \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl get pods -n vantage -w"
```

Expected startup sequence:

| Pod | Typical ready time | Notes |
|-----|--------------------|-------|
| redis, dashboard | ~15s | |
| postgres | ~30s | |
| ingestion-service | ~30s | |
| alert-engine | after postgres | 1–3 CrashLoopBackOff restarts — expected |
| api-service | ~15s | |
| telemetry-simulator | ~20s | |
| elasticsearch | 2–4 min | initContainer sets vm.max_map_count first |
| event-store-service | after ES | 3–6 restarts waiting for ES — expected |
| prometheus, grafana | ~30s | |

Total: **5–8 minutes**. Image pulls from `ghcr.io` add time on first deploy. Ctrl-C once all pods are Running, then confirm:

```bash
ssh -i ~/.ssh/vantage-deploy rocky@$EIP \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl get pods -n vantage"
```

All 11 pods: `STATUS: Running`, `READY: 1/1`.

### 4.3 Verify API endpoints

On EC2, Traefik's `LoadBalancer` service binds port 80 directly on the host via K3s ServiceLB. Traffic hits the Elastic IP → NATs to the EC2 private IP → Traefik. No port-forward needed.

```bash
# Device state — three devices within ~15s of simulator starting
curl -s http://$EIP/api/devices | jq 'length'

# Alarm list — empty initially
curl -s http://$EIP/api/alarms | jq '{total, count: (.alarms | length)}'

# Event search
curl -s "http://$EIP/api/events/search?from=now-5m&to=now" | jq '.total'
```

Expected: devices returns `3`. Alarms returns `{total: 0, count: 0}`.

### 4.4 End-to-end alarm trigger

```bash
curl -X POST http://$EIP/api/scenarios/norm-threshold
curl -s http://$EIP/api/alarms | jq '.alarms[0].alarmSubtype'
```

Expected: `"NORM_THRESHOLD"` within 2 seconds.

### 4.5 WebSocket smoke test

```bash
# From your local machine:
wscat -c ws://$EIP/ws
```

With wscat open, trigger a scenario:

```bash
curl -X POST http://$EIP/api/scenarios/isotope-identified
```

Expected: alarm JSON message received in wscat within 2 seconds. If the message arrives, Traefik is correctly proxying the WebSocket Upgrade.

**60-second idle test:** leave the wscat connection open for 65+ seconds without triggering any scenarios. Then trigger one more:

```bash
curl -X POST http://$EIP/api/scenarios/concurrent
```

The alarm must arrive in the same wscat session — confirming the server-side ping from Part 1.3 is keeping the connection alive through Traefik's idle timeout.

### 4.6 Browser smoke test

Open `http://$EIP/` in a browser:
- Angular app loads with three device status cards
- Trigger a scenario from the Test Mode panel — alarm appears in Active Alarms within 2 seconds without page refresh
- Acknowledge an alarm — it leaves the Active Alarms panel
- Detection Event Search returns results
- Alarm History shows all triggered alarms

### 4.7 Grafana verification

Open `http://$EIP/grafana/` in a browser.

**Credentials (manual deploy):** `admin` / `vantage`

Navigate to **Dashboards → Browse**. All three dashboards should be present:
- Alarm Path Health
- Indexing Path Health
- Device Activity

Trigger a scenario, then open each dashboard and confirm metrics are updating (not `No data`). If dashboards show `No data`, check Prometheus is scraping:

```bash
# Port-forward to Prometheus (Prometheus is not exposed through the public ingress)
ssh -i ~/.ssh/vantage-deploy rocky@$EIP \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   kubectl port-forward -n vantage svc/vantage-demo-prometheus-server 9090:80 &"

# Then from your local machine:
curl -s http://localhost:9090/api/v1/targets | \
  jq '[.data.activeTargets[] | {job: .labels.job, health}]'
```

Expected: all targets showing `health: "up"`. If any show `"down"`, check that Kubernetes service names in the Prometheus scrape configmap match the actual service names in the `vantage` namespace.

---

## Part 5: CI/CD Wiring

### 5.1 Confirm repository is public

Navigate to `https://github.com/ApeOnFire/REPO_NAME`. Confirm it is publicly accessible without login. If not, **Settings → Danger Zone → Change repository visibility → Public**. All `ghcr.io` packages linked to the repo automatically become public.

### 5.2 Add GitHub Actions secrets

Navigate to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `EC2_SSH_KEY` | Full content of `~/.ssh/vantage-deploy` (including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----` lines) |
| `EC2_HOST` | The Elastic IP address |
| `GRAFANA_ADMIN_PASSWORD` | A password for the Grafana admin account on EC2 (e.g. a random string — not `vantage`) |

`GITHUB_TOKEN` is automatic.

**Key format:** paste the full multi-line private key exactly as produced by `cat ~/.ssh/vantage-deploy`. The newlines are required.

### 5.3 Push to main and verify automated deploy

```bash
git commit --allow-empty -m "trigger first automated deploy"
git push origin main
```

Watch **Actions → CI** then **Actions → Deploy**. After the `deploy` job shows green:

```bash
ssh -i ~/.ssh/vantage-deploy rocky@$EIP \
  "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; kubectl get pods -n vantage"
```

All pods Running. Confirm `http://$EIP/` is serving the dashboard and Grafana is accessible with the new password from `GRAFANA_ADMIN_PASSWORD`.

### 5.4 Test the quality gate

Break a unit test, push to main. Confirm:
1. `ci.yml` fails on the `test` job
2. **Actions → Deploy** — no new workflow run appears

Revert and push again.

---

## Part 6: Optional — HTTPS with cert-manager

Requires a domain name with an A record pointing at `$EIP`. HTTP-only is acceptable for the demo DoD.

### 6.1 Install cert-manager

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

kubectl get pods -n cert-manager -w
```

### 6.2 Create ClusterIssuer

Create `helm/vantage-demo/templates/cluster-issuer.yaml`:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: duncan@foodforbenjamin.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
```

### 6.3 Update `ingress.yaml` and `values-production.yaml`

Add cert-manager annotation and TLS block to `ingress.yaml`:

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - "{{ .Values.global.hostname }}"
      secretName: vantage-demo-tls
  rules:
    - host: "{{ .Values.global.hostname }}"
      # ... existing rules unchanged ...
```

Add to `helm/vantage-demo/values.yaml`:

```yaml
global:
  hostname: ""
```

Add to `helm/vantage-demo/values-production.yaml`:

```yaml
global:
  hostname: yourdomain.example.com
```

### 6.4 Upgrade and verify

```bash
# On EC2
cd /opt/vantage-demo && git pull origin main
helm dependency build helm/vantage-demo
helm upgrade vantage-demo helm/vantage-demo \
  --namespace vantage \
  --values helm/vantage-demo/values-production.yaml \
  --set global.imageTag=latest \
  --set grafana.adminPassword=$GRAFANA_ADMIN_PASSWORD

kubectl get certificate -n vantage -w
```

Expected: `READY: True` within ~60 seconds.

---

## Part 7: README

Write `README.md` at the repo root. Required content:

**What it is:** one paragraph. C2 operator platform for radiation detection. Simulates three devices. Shows real-time alarm propagation via WebSocket and three Grafana operational dashboards.

**Architecture diagram:** embed the Mermaid diagram from `docs/build-spec-vantage-demo.md`.

**Live demo link:** `http://<EIP>/`. Include a screenshot with an active alarm visible.

**Test Mode:** brief instructions for the three scenario buttons and equivalent curl commands.

**Stack:** table — Node.js/TypeScript microservices, K3s, Helm, PostgreSQL, Redis, Elasticsearch, Angular, Prometheus, Grafana.

**Local setup:** one-line pointer to Phase 9 plan.

Keep it under one page.

---

## Troubleshooting

### Pods stuck in `ImagePullBackOff`

```bash
kubectl describe pod <pod-name> -n vantage | grep -A 10 Events
```

**`unauthorized`:** packages are still private. Make repo public — all linked packages become public automatically.

**`not found` / `manifest unknown`:** the `build-and-push` job did not complete. Check **Actions → Deploy → build-and-push** on GitHub.

### deploy.yml SSH step: `Permission denied (publickey)`

1. Verify `EC2_SSH_KEY` contains the full private key including header/footer lines
2. Verify the corresponding public key is in `/home/rocky/.ssh/authorized_keys` on EC2
3. Verify `EC2_HOST` is the Elastic IP, not a DNS name or private IP

### deploy.yml: `kubectl: command not found` or `Kubernetes cluster unreachable`

The `export KUBECONFIG=...` prefix is missing from the SSH command. Verify that `deploy.yml`'s SSH command starts with `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml;`.

### `helm upgrade --wait` times out

```bash
kubectl get pods -n vantage
kubectl describe pod <failing-pod> -n vantage | tail -30
```

Common causes: Elasticsearch still starting (~4 min on first deploy); `ImagePullBackOff` due to registry issue; OOMKill (t3.large has 8 GB — sufficient for this stack with Elasticsearch capped at 1 GB, but check `kubectl describe node`).

### Traefik returns 404 for `/api/*` routes

```bash
kubectl get ingress -n vantage
kubectl describe ingress vantage-demo-ingress -n vantage
```

Confirm: `ingressClassName: traefik` (not `nginx`), backend service is `vantage-demo-api-service` on port `3004`.

### WebSocket drops after ~60 seconds

The server-side ping from Part 1.3 was not applied or the api-service image was not rebuilt. Verify the heartbeat `setInterval` is present in the deployed api-service code. If using `helm upgrade` with `--set global.imageTag=latest`, ensure the image was rebuilt after Part 1.3's commit.

### Grafana shows `No data`

Port-forward to Prometheus (not exposed through the public ingress) and check targets:

```bash
kubectl port-forward -n vantage svc/vantage-demo-prometheus-server 9090:80
# In a second terminal:
curl -s http://localhost:9090/api/v1/targets | \
  jq '[.data.activeTargets[] | select(.health != "up") | .labels.job]'
```

Empty array = all targets healthy. Non-empty = those jobs are failing. Check that service names in the Prometheus scrape configmap match the actual Kubernetes service names in the `vantage` namespace.

---

## Definition of Done

**AWS provisioning:**
- [ ] `t3.large` instance running Rocky Linux 9, 50 GB gp3 root volume
- [ ] Elastic IP allocated and associated
- [ ] Security group: TCP 22, 80, 443 open

**EC2 setup:**
- [ ] K3s running, one node Ready
- [ ] Traefik running in kube-system
- [ ] Helm installed, `KUBECONFIG` set in `~/.bash_profile`
- [ ] `/opt/vantage-demo` cloned, Helm dependencies built

**Code changes:**
- [ ] `ingress.yaml` uses `ingressClassName: traefik`, no nginx annotations
- [ ] `deploy.yml` SSH command: inline KUBECONFIG, `--namespace vantage`, `--set grafana.adminPassword`
- [ ] api-service WebSocket heartbeat interval added
- [ ] `helm lint` passes

**First manual deploy:**
- [ ] All 11 pods Running 1/1 in `vantage` namespace
- [ ] `curl http://$EIP/api/devices | jq length` returns `3`
- [ ] Scenario trigger → alarm in UI within 2s
- [ ] WebSocket confirmed live via wscat; alarm still arrives after 65-second idle period
- [ ] Grafana accessible at `http://$EIP/grafana/`, login works (`admin`/`vantage`), all three dashboards show live data

**CI/CD pipeline:**
- [ ] `EC2_SSH_KEY`, `EC2_HOST`, `GRAFANA_ADMIN_PASSWORD` secrets added
- [ ] Push to `main` → CI passes → deploy triggers automatically
- [ ] `helm upgrade --wait` completes, all pods Running with new image digest
- [ ] Grafana login works with `GRAFANA_ADMIN_PASSWORD` value after automated deploy
- [ ] Quality gate: failing test → CI fails → deploy does not trigger

**README:**
- [ ] README at repo root with architecture diagram, live demo link, stack summary, screenshot
