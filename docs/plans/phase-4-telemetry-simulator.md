---
status: Implemented
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-2-alert-engine.md
---

# Phase 4: telemetry-simulator

## Objective

Build the `telemetry-simulator` service: a Fastify HTTP server that drives three simulated devices (`PM-01`, `PM-02`, `RIID-01`), continuously emitting detection events and heartbeats to ingestion-service. It also exposes `POST /scenario/:name` for Test Mode injection, which the operator UI uses to trigger alarm scenarios on demand.

By this phase, ingestion-service (Phase 3) and alert-engine (Phase 2) are both running locally. Adding the simulator closes the first end-to-end data flow: device events → ingestion → alert evaluation → alarm record in PostgreSQL.

When this phase is complete:

- All three devices emit detection events every ~15 seconds and heartbeats every 5 seconds
- Logs show steady `emitted event` lines for each device
- Redis holds `device:state:PM-01`, `device:state:PM-02`, `device:state:RIID-01` with 30s TTLs (set by ingestion-service)
- `POST /scenario/norm-threshold` → alarm record in PostgreSQL within 2 seconds
- Alert-engine logs a warn about api-service notify — expected; api-service does not exist until Phase 6

---

## File Tree

```
apps/telemetry-simulator/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # entry point: start server → start loops
    ├── server.ts       # Fastify app factory — /scenario/:name, /metrics, /health
    ├── logger.ts       # shared pino instance
    ├── metrics.ts      # prom-client registry + default metrics
    ├── devices.ts      # device definitions (ids, types, site)
    ├── emit.ts         # HTTP client — sends events/heartbeats to ingestion-service
    ├── loops.ts        # setInterval loops + event/heartbeat builders
    └── scenarios.ts    # scenario dispatch — runScenario(name)
```

No test files. The simulator has no testable pure logic (the normal distribution is standard math; the scenario dispatch is trivial wiring). Verification is observational — watch the logs and check PostgreSQL/Redis state.

---

## `apps/telemetry-simulator/package.json`

```json
{
  "name": "@vantage/telemetry-simulator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx --env-file=../../.env src/index.ts",
    "dev": "tsx watch --env-file=../../.env src/index.ts"
  },
  "dependencies": {
    "@vantage/types": "workspace:*",
    "fastify": "^5.0.0",
    "pino": "^10.0.0",
    "prom-client": "^15.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "vitest": "^4.0.0"
  }
}
```

No additional dependencies beyond the standard service stack. `crypto.randomUUID()` (Node.js 22 built-in) generates event UUIDs — no `uuid` package needed. The Box-Muller transform for normally distributed count rates is implemented inline — no statistics library.

`vitest` is included as a devDependency to match the pattern established in Phase 2: keeps the app self-contained for any future per-service CI matrix jobs, even though there are no test files in this phase.

---

## `apps/telemetry-simulator/tsconfig.json`

Standard app tsconfig extending the shared base — identical to alert-engine.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

---

## `src/logger.ts`

Same pattern as alert-engine — single pino instance shared by the entire service.

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    bindings: (bindings) => ({ ...bindings, service: 'telemetry-simulator' }),
  },
});
```

---

## `src/metrics.ts`

Registry with default Node.js metrics only. No custom metrics are specified for the simulator in the spec — Prometheus scrapes this endpoint from Phase 10 onward.

```typescript
import { Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });
```

---

## `src/devices.ts`

Device definitions as a typed constant array. `SITE_ID` and `VENDOR_ID` are co-located here since they apply uniformly to all simulated devices.

```typescript
export interface Device {
  deviceId: string;
  deviceType: 'PORTAL_MONITOR' | 'RIID';
}

export const SITE_ID = 'POE-ALPHA';
export const VENDOR_ID = 'VANTAGE';

export const DEVICES: Device[] = [
  { deviceId: 'PM-01', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'PM-02', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'RIID-01', deviceType: 'RIID' },
];
```

---

## `src/emit.ts`

HTTP client for ingestion-service. Both functions throw on network failure or a non-ok response — responsibility for handling those errors sits with the caller (loops swallow with `.catch()`; scenarios let errors propagate to the HTTP handler). A 5-second `AbortController` timeout prevents hung fetch calls from accumulating across interval ticks.

`ingestionUrl` is exported so `index.ts` can log the resolved value at startup without re-reading the env var.

```typescript
import type { DetectionEvent, Heartbeat } from '@vantage/types';
import { logger } from './logger.js';

export const ingestionUrl =
  process.env.INGESTION_SERVICE_URL ?? 'http://localhost:3001';

export async function emitEvent(event: DetectionEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${ingestionUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ingestion-service rejected event: HTTP ${res.status}`);
    }
    logger.debug({ deviceId: event.deviceId }, 'emitted event');
  } finally {
    clearTimeout(timeout);
  }
}

export async function emitHeartbeat(heartbeat: Heartbeat): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${ingestionUrl}/heartbeats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeat),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ingestion-service rejected heartbeat: HTTP ${res.status}`);
    }
    logger.debug({ deviceId: heartbeat.deviceId }, 'emitted heartbeat');
  } finally {
    clearTimeout(timeout);
  }
}
```

**Why functions throw instead of swallowing:** `emitEvent` is called from two contexts with different requirements — background loops (should log and continue) and scenario injection (should surface errors to the HTTP caller). A function that swallows errors makes the scenario context impossible to implement correctly. Throwing and letting each caller decide is the correct separation. Alert-engine's fire-and-forget notify used a different pattern because it was always best-effort with no upstream caller waiting; here the scenario path has an explicit waiting caller.

**5-second timeout:** Long enough for a briefly-loaded ingestion-service to respond (the alert-engine round-trip adds latency). Short enough that a hung connection doesn't block more than one interval tick for the heartbeat loop. `clearTimeout` in `finally` ensures the timeout is cleared on success, failure, or abort — no timer leak.

**`debug` for success logs:** Both emit functions log at `debug` on success (12 detection + 36 heartbeat = 48 lines/minute at the default interval). These are routine confirmation signals, not state-change events. `info` is reserved for startup, shutdown, and scenario triggers. Set `LOG_LEVEL=debug` when actively verifying loops are running.

---

## `src/loops.ts`

Detection event and heartbeat loops. Includes the event/heartbeat builder functions and the Box-Muller transform for normally distributed count rates.

```typescript
import crypto from 'node:crypto';
import type { DetectionEvent, Heartbeat, RadiationPayload } from '@vantage/types';
import { DEVICES, SITE_ID, VENDOR_ID, type Device } from './devices.js';
import { emitEvent, emitHeartbeat } from './emit.js';
import { logger } from './logger.js';

const parsedIntervalMs = Number(process.env.EVENT_INTERVAL_MS ?? 15_000);
const EVENT_INTERVAL_MS = Number.isFinite(parsedIntervalMs) && parsedIntervalMs >= 1000 ? parsedIntervalMs : 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

// Box-Muller transform — generates a normally distributed sample.
// Returns an integer clamped to a minimum of 1 (count rates are always positive).
// u1 is resampled if exactly 0 to avoid Math.log(0) = -Infinity → NaN.
function normalSample(mean: number, sigma: number): number {
  let u1: number;
  do { u1 = Math.random(); } while (u1 === 0);
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1, Math.round(mean + sigma * z));
}

function buildDetectionEvent(device: Device): DetectionEvent {
  // backgroundCountRate is generated first; peakCountRate is clamped to be at
  // least as large — a detector's peak cannot be below the ambient background.
  const backgroundCountRate = normalSample(45, 5);
  const peakCountRate = Math.max(backgroundCountRate, normalSample(45, 8));

  const payload: RadiationPayload = {
    type: 'RADIATION_SCAN',
    durationMs: 2000,
    peakCountRate,
    backgroundCountRate,
    isotope: null,
    detectorAlarmSubtype: null,
  };

  return {
    eventId: crypto.randomUUID(),
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    siteId: SITE_ID,
    timestamp: new Date().toISOString(),
    vendorId: VENDOR_ID,
    eventType: 'RADIATION_SCAN',
    platformAlarmStatus: 'CLEAR',   // ingestion-service unconditionally overwrites this
    payload,
  };
}

function buildHeartbeat(device: Device): Heartbeat {
  return {
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    timestamp: new Date().toISOString(),
    backgroundCountRate: normalSample(45, 5),
    status: 'ONLINE',
  };
}

export function startDetectionLoop(): void {
  logger.info(
    { intervalMs: EVENT_INTERVAL_MS, deviceCount: DEVICES.length },
    'starting detection event loops',
  );
  for (const device of DEVICES) {
    setInterval(() => {
      emitEvent(buildDetectionEvent(device)).catch((err) => {
        logger.warn({ err, deviceId: device.deviceId }, 'failed to emit event');
      });
    }, EVENT_INTERVAL_MS);
  }
}

export function startHeartbeatLoop(): void {
  logger.info(
    { intervalMs: HEARTBEAT_INTERVAL_MS, deviceCount: DEVICES.length },
    'starting heartbeat loops',
  );
  for (const device of DEVICES) {
    setInterval(() => {
      emitHeartbeat(buildHeartbeat(device)).catch((err) => {
        logger.warn({ err, deviceId: device.deviceId }, 'failed to emit heartbeat');
      });
    }, HEARTBEAT_INTERVAL_MS);
  }
}
```

**Box-Muller clamp at 1:** Count rates are always positive — a background scan physically cannot return 0 or negative cps. Clamping at 1 ensures the value is always a positive non-zero integer. The `u1 === 0` guard prevents `Math.log(0) = -Infinity`, which would make the whole expression `NaN` — a value that survives `Math.max(1, NaN)` as `NaN` and would serialise to `null` in JSON.

**`peakCountRate >= backgroundCountRate` invariant:** Background count rate is generated first; peak is clamped to be at least as large. A portal monitor's peak count rate is the maximum detected during the scan window — it cannot be below the ambient background. Violating this would produce data that looks wrong to any interviewer who queries Elasticsearch or looks at the Grafana device activity panel.

**`EVENT_INTERVAL_MS` env var:** Lets the presenter shorten the interval (e.g. `EVENT_INTERVAL_MS=5000`) if they want faster event throughput during a demo without code changes. Default 15000ms matches the spec.

**`platformAlarmStatus: 'CLEAR'` on all generated events:** The `DetectionEvent` type's inline comment explains this. Ingestion-service unconditionally overwrites this field with the result of alert-engine evaluation. The simulator always sends `'CLEAR'` as a placeholder. The `detectorAlarmSubtype` in the payload is different — it represents what the detector hardware itself reported about the raw scan (see `scenarios.ts`).

**Unhandled promise rejection guard:** `setInterval` callbacks are not `async`, so without `.catch()` a rejected promise from `emitEvent`/`emitHeartbeat` would produce an unhandled rejection (Node.js emits a warning; in strict mode it exits). The `.catch()` on each call ensures the failure surfaces as a `warn` log line instead.

---

## `src/scenarios.ts`

Scenario injection. Each scenario builds an alarm-triggering `DetectionEvent` and dispatches it via `emitEvent`, which throws on failure. `runScenario` lets errors propagate — the `server.ts` handler catches them and maps them to HTTP status codes.

`UnknownScenarioError` is a named class so `server.ts` can distinguish a bad scenario name (404) from an ingestion-service failure (502) without string-matching.

```typescript
import crypto from 'node:crypto';
import type { DetectionEvent, RadiationPayload } from '@vantage/types';
import { DEVICES, SITE_ID, VENDOR_ID } from './devices.js';
import { emitEvent } from './emit.js';

export class UnknownScenarioError extends Error {
  constructor(name: string) {
    super(`Unknown scenario: ${name}`);
    this.name = 'UnknownScenarioError';
  }
}

interface AlarmEventSpec {
  deviceId: string;
  peakCountRate: number;
  isotope: string | null;
  detectorAlarmSubtype: 'NORM_THRESHOLD' | 'ISOTOPE_IDENTIFIED';
}

function buildAlarmEvent(spec: AlarmEventSpec): DetectionEvent {
  const device = DEVICES.find((d) => d.deviceId === spec.deviceId);
  if (!device) throw new Error(`Unknown deviceId: ${spec.deviceId}`);

  const payload: RadiationPayload = {
    type: 'RADIATION_SCAN',
    durationMs: 2000,
    peakCountRate: spec.peakCountRate,
    backgroundCountRate: 45,
    isotope: spec.isotope,
    detectorAlarmSubtype: spec.detectorAlarmSubtype,
  };

  return {
    eventId: crypto.randomUUID(),
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    siteId: SITE_ID,
    timestamp: new Date().toISOString(),
    vendorId: VENDOR_ID,
    eventType: 'RADIATION_SCAN',
    platformAlarmStatus: 'CLEAR',
    payload,
  };
}

export async function runScenario(name: string): Promise<void> {
  switch (name) {
    case 'norm-threshold':
      await emitEvent(
        buildAlarmEvent({
          deviceId: 'PM-01',
          peakCountRate: 320,
          isotope: null,
          detectorAlarmSubtype: 'NORM_THRESHOLD',
        }),
      );
      break;

    case 'isotope-identified':
      await emitEvent(
        buildAlarmEvent({
          deviceId: 'PM-02',
          peakCountRate: 180,
          isotope: 'Cs-137',
          detectorAlarmSubtype: 'ISOTOPE_IDENTIFIED',
        }),
      );
      break;

    case 'concurrent':
      await Promise.all([
        emitEvent(
          buildAlarmEvent({
            deviceId: 'PM-01',
            peakCountRate: 320,
            isotope: null,
            detectorAlarmSubtype: 'NORM_THRESHOLD',
          }),
        ),
        emitEvent(
          buildAlarmEvent({
            deviceId: 'PM-02',
            peakCountRate: 180,
            isotope: 'Cs-137',
            detectorAlarmSubtype: 'ISOTOPE_IDENTIFIED',
          }),
        ),
      ]);
      break;

    default:
      throw new UnknownScenarioError(name);
  }
}
```

**`detectorAlarmSubtype` in scenario events:** Background events always have `detectorAlarmSubtype: null` — the detector saw nothing alarming. Scenario events set this to match what the device would have reported. This keeps `detectorAlarmSubtype` meaningful (it's the hardware's verdict) distinct from `alarmSubtype` in the alarm record (the platform's rule evaluation verdict). Both will agree for these scenarios, but they are conceptually separate fields.

**`peakCountRate: 180` for isotope-identified scenario:** A peakCountRate of 180 is below the 250 NORM_THRESHOLD. This ensures alert-engine fires `ISOTOPE_IDENTIFIED` (the isotope rule), not `NORM_THRESHOLD` (the count rate rule). The "first matching rule wins" contract means NORM_THRESHOLD rule is evaluated first — keeping peakCountRate below 250 forces the path through the isotope rule.

**`runScenario` awaits `emitEvent`:** Unlike the background loops (which fire-and-forget), scenario injection awaits the ingestion-service response before returning. The `POST /scenario/:name` HTTP response reflects whether the event was accepted. This gives the dashboard operator immediate feedback — if ingestion-service is down, the scenario button gets an error response rather than a silent no-op.

---

## `src/server.ts`

Fastify app factory. Registers the scenario route; adds `/metrics` and `/health`.

```typescript
import Fastify from 'fastify';
import { runScenario, UnknownScenarioError } from './scenarios.js';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  app.post<{ Params: { name: string } }>(
    '/scenario/:name',
    async (request, reply) => {
      const { name } = request.params;
      try {
        logger.info({ scenario: name }, 'scenario requested');
        await runScenario(name);
        return reply.send({ ok: true, scenario: name });
      } catch (err) {
        if (err instanceof UnknownScenarioError) {
          return reply.status(404).send({ error: err.message });
        }
        logger.warn({ err, scenario: name }, 'scenario emit failed');
        return reply
          .status(502)
          .send({ error: 'failed to deliver scenario event to ingestion-service' });
      }
    },
  );

  app.get('/metrics', async (_request, reply) => {
    const output = await registry.metrics();
    return reply
      .header('Content-Type', registry.contentType)
      .send(output);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
```

---

## `src/index.ts`

Entry point. Server starts first so the process is ready to handle health checks and scenario requests before background loops begin. Loops start after the server is listening.

```typescript
import { buildServer } from './server.js';
import { startDetectionLoop, startHeartbeatLoop } from './loops.js';
import { ingestionUrl } from './emit.js';
import { logger } from './logger.js';

async function main() {
  logger.info({ ingestionUrl }, 'telemetry-simulator starting');

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'telemetry-simulator ready');

  startHeartbeatLoop();
  startDetectionLoop();
}

main().catch((err) => {
  logger.error({ err }, 'telemetry-simulator startup failed');
  process.exit(1);
});
```

`INGESTION_SERVICE_URL` is not required to exit on missing — the `emit.ts` default of `http://localhost:3001` is always sensible for local dev. Logging it at startup makes the configured value visible in `kubectl logs` for K3s verification.

---

## Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `INGESTION_SERVICE_URL` | `http://localhost:3001` | Target for events and heartbeats |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Set `debug` to see individual emit lines |
| `EVENT_INTERVAL_MS` | `15000` | Detection event loop interval per device |

These are loaded from `../../.env` in local dev via `tsx --env-file`. In K3s they come from the Helm chart's `env:` block.

---

## Verification Steps

Run after implementing all files.

**1. Install dependencies**

```bash
pnpm install
```

**2. Typecheck**

```bash
pnpm typecheck
```

Expected: exits 0.

**3. Lint**

```bash
pnpm lint
```

Expected: exits 0.

**4. Start infra (if not already running)**

```bash
pnpm infra:up
```

**5. Start all three services**

In three separate terminals:

```bash
# Terminal 1
cd apps/alert-engine && pnpm start

# Terminal 2
cd apps/ingestion-service && pnpm start

# Terminal 3
cd apps/telemetry-simulator && pnpm start
```

**6. Confirm heartbeats are reaching Redis**

```bash
docker compose exec redis redis-cli TTL device:state:PM-01
```

Expected: a number between 1 and 30 (the TTL set by ingestion-service on each heartbeat). Run twice a few seconds apart to confirm it is resetting.

**7. Confirm events are flowing (logs)**

Telemetry-simulator logs at `debug` level show `"emitted event"` for each device. ingestion-service logs show `POST /events 202` lines. At default `info` level, the emit lines are suppressed — watch ingestion-service logs instead, or restart the simulator with `LOG_LEVEL=debug`.

**8. Trigger norm-threshold scenario**

```bash
curl -s -X POST http://localhost:3000/scenario/norm-threshold
```

Expected response: `{"ok":true,"scenario":"norm-threshold"}`

Alert-engine logs should show the evaluate call and an alarm insert. Alert-engine will also log a `warn` about api-service notify failing — this is expected.

**9. Confirm alarm record in PostgreSQL**

```bash
docker compose exec postgres psql -U vantage -d vantage \
  -c "SELECT device_id, alarm_subtype, status, triggered_at FROM alarms ORDER BY created_at DESC LIMIT 5;"
```

Expected: a row with `device_id: PM-01`, `alarm_subtype: NORM_THRESHOLD`, `status: ACTIVE`.

**10. Trigger isotope-identified scenario**

```bash
curl -s -X POST http://localhost:3000/scenario/isotope-identified
```

Confirm a second alarm row appears: `device_id: PM-02`, `alarm_subtype: ISOTOPE_IDENTIFIED`.

**11. Trigger concurrent scenario**

```bash
curl -s -X POST http://localhost:3000/scenario/concurrent
```

Confirm two alarm rows appear (one PM-01 NORM_THRESHOLD, one PM-02 ISOTOPE_IDENTIFIED) within 2 seconds.

**12. Test unknown scenario returns 404**

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/scenario/unknown
```

Expected: `404`.

**13. Verify device offline detection**

Stop the simulator (Ctrl-C). Wait 35 seconds (30s TTL + 5s buffer). Then confirm the Redis key has expired:

```bash
docker compose exec redis redis-cli EXISTS device:state:PM-01
```

Expected: `0` (key expired — ingestion-service will return `status: "OFFLINE"` for this device when api-service queries it in Phase 6).

---

## Decisions

**Box-Muller transform, no external library:** `Math.random()` is uniform; normally distributed count rates require a transform. Box-Muller is the canonical approach — two uniform samples produce one normal sample. The alternative (importing a statistics library) adds a dependency for three lines of math. The transform is inlined with a comment so future readers don't need to look it up.

**Clamp at 1, guard against `u1 = 0`:** `Math.max(1, ...)` handles the domain invariant (count rates are always positive). The `do...while (u1 === 0)` guard handles the math invariant — `Math.log(0)` is `-Infinity`, which makes the entire expression `NaN`, and `Math.max(1, NaN)` returns `NaN` rather than 1 (JavaScript's `Math.max` with NaN propagates NaN). Without the guard, a vanishingly rare `Math.random() === 0` would produce a NaN peakCountRate that silently serialises to `null` in JSON.

**`crypto.randomUUID()` over a uuid package:** Node.js 22 includes `crypto.randomUUID()` as a built-in. Adding the `uuid` package would add a dependency for something already available.

**No unit tests:** The simulator has no pure logic worth isolating. `buildDetectionEvent` is a constructor for a plain object — testing it would be testing types. `runScenario` is a switch statement over known string constants. Box-Muller correctness is established math. The observable integration test (events arrive at ingestion-service, alarms appear in PostgreSQL) provides more signal than any unit test could here.

**`emitEvent` throws; callers decide how to handle failures:** `emitEvent` is called from two contexts with different requirements — background loops (should log and continue) and scenario injection (should surface errors to the HTTP caller). A function that swallows errors makes the scenario context impossible to implement correctly. The function throws; loops attach `.catch()` to log and continue; `runScenario` lets errors propagate to `server.ts`, which returns 502. This separation of mechanism from policy is cleaner than a boolean flag or dual-function approach.

**`UnknownScenarioError` custom class over string matching:** `server.ts` needs to distinguish a bad scenario name (404) from an ingestion-service failure (502). String-matching on `err.message` would silently return 500 if the error message text changed. `instanceof UnknownScenarioError` is type-safe and refactor-resistant. The class lives in `scenarios.ts` and is imported by `server.ts`.

**`ingestionUrl` exported from `emit.ts`:** `index.ts` logs the resolved URL at startup for operational visibility. Rather than re-reading the env var independently (two sources of truth for the same value), `index.ts` imports `ingestionUrl` from `emit.ts`. They are guaranteed to agree, but the single-source pattern is cleaner.

**Loops start after server.listen():** K8s readiness probes hit `/health` before treating the pod as ready. If loops started before the server was bound, K8s might send traffic (scenario requests) to a pod whose HTTP server wasn't accepting connections yet. Server-first is always the correct startup order.

**`INGESTION_SERVICE_URL` has a localhost default:** Unlike `DATABASE_URL` in alert-engine (where there's no sensible default and startup must fail), the ingestion-service URL has a well-defined localhost equivalent for local dev. The default is logged at startup, so operators can see what's configured without checking env vars manually.

**`concurrent` uses `Promise.all`:** The scenario fires both events simultaneously. If they were sequential (`await` each), the second event would only be sent after ingestion-service fully processed the first (including the alert-engine round-trip). `Promise.all` fires both fetch calls in parallel, which is the intended concurrent behaviour and means both alarms appear at approximately the same time in the UI.

**Port 3000:** Matches the local port assignment table in the roadmap. The simulator is the lowest-level entry point in the data flow (it calls ingestion, which calls alert-engine), so port 3000 is appropriate as the numerically lowest service port.

---

## Phase 3 Interface Assumptions

This service assumes ingestion-service exposes the following endpoints (to be confirmed against the Phase 3 plan before implementing):

- `POST /events` — accepts a `DetectionEvent` JSON body; returns 2xx on success
- `POST /heartbeats` — accepts a `Heartbeat` JSON body; returns 2xx on success

Both are called by `emit.ts`. Non-2xx responses and network errors both surface as thrown errors, caught and logged as `warn` by the loops.
