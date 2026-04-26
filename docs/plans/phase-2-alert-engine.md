---
status: Implemented
created: 2026-04-25
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-1-foundation.md
---

# Phase 2: alert-engine

## Objective

Build the `alert-engine` service: a Fastify HTTP server that receives `DetectionEvent` objects, evaluates them against alarm rules loaded from PostgreSQL, writes alarm records when rules match, and notifies api-service on a best-effort basis. The evaluation core is a pure function with seven unit tests. Rule hot-reload is driven by PostgreSQL LISTEN/NOTIFY.

Phase 1 produced the monorepo scaffold, `@vantage/types`, and the local docker-compose infra. Phase 2 builds the first service. No other services exist yet — alert-engine will attempt to notify api-service and fail gracefully every time until Phase 6.

When this phase is complete:
- `pnpm test` runs all seven evaluate unit tests and passes
- alert-engine starts on port 3002 against docker-compose
- `curl -X POST localhost:3002/evaluate` with a radiation payload returns `{ alarmTriggered: true, alarmId, alarmSubtype }` or `{ alarmTriggered: false }`
- Alarm records are visible in PostgreSQL `alarms` table

---

## File Tree

```
apps/alert-engine/
├── package.json
├── tsconfig.json
├── migrations/
│   └── 1745000000000_initial.js
└── src/
    ├── index.ts            # entry point: migrate → load rules → start listener → listen
    ├── server.ts           # Fastify app factory
    ├── db.ts               # pg pool + rule loader + LISTEN/NOTIFY client
    ├── evaluate.ts         # pure evaluate(event, rules) function
    ├── evaluate.test.ts    # seven unit tests
    ├── rules.ts            # in-process rule cache (module-level singleton)
    ├── metrics.ts          # prom-client registry + histogram
    ├── logger.ts           # shared pino instance for the entire service
    └── routes/
        └── evaluate.ts     # POST /evaluate handler
```

---

## `apps/alert-engine/package.json`

```json
{
  "name": "@vantage/alert-engine",
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
    "node-pg-migrate": "^8.0.0",
    "pg": "^8.0.0",
    "pino": "^10.0.0",
    "prom-client": "^15.0.0"
  },
  "devDependencies": {
    "@types/pg": "^8.0.0",
    "tsx": "^4.0.0",
    "vitest": "^4.0.0"
  }
}
```

`@vantage/types` is the only workspace dependency. All other dependencies are standard for a Node.js HTTP microservice. `tsx` is a devDependency here (as established in Phase 1 decisions); the `start` script uses it directly.

`vitest` appears here even though the root `vitest.config.ts` already discovers all tests — this is intentional. The root `pnpm test` handles CI (single job across all apps). Per-app `vitest` enables `pnpm test` from within the service directory during development, and keeps the app self-contained for any future per-service CI matrix jobs. Every subsequent service phase follows this same pattern.

---

## `apps/alert-engine/tsconfig.json`

Standard app tsconfig extending the shared base — identical pattern to Phase 1.

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

## `migrations/1745000000000_initial.js`

Creates both tables, the NOTIFY trigger, and seeds the two radiation alarm rules. Uses explicit UUIDs for the seed rows to guarantee lexicographic sort order matches evaluation priority (NORM_THRESHOLD before ISOTOPE_IDENTIFIED). This is the only migration in the demo; it is idempotent via `node-pg-migrate`'s migration tracking table.

**ESM migration files:** With `"type": "module"` in `package.json`, `.js` migration files are treated as ESM by Node. node-pg-migrate v8 is ESM-native — it loads migration files via dynamic `import()` — so `.js` ESM migration files work correctly with no workaround needed. This is why the plan pins `^8.0.0`. Earlier versions (pre-v7) used `require()` internally and threw `ERR_REQUIRE_ESM` for `.js` ESM files; there was a known GitHub issue about this. v8 resolves it definitively. If for any reason the migration loader causes issues, renaming to `.cjs` with `module.exports = { up, down }` is the escape hatch.

```javascript
/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.createTable('alarm_rules', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_type: { type: 'text', notNull: true },
    field: { type: 'text', notNull: true },
    operator: { type: 'text', notNull: true },
    threshold: { type: 'numeric' },
    alarm_subtype: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
  });

  pgm.createTable('alarms', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    device_id: { type: 'text', notNull: true },
    site_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    alarm_subtype: { type: 'text', notNull: true },
    peak_count_rate: { type: 'numeric' },
    isotope: { type: 'text' },
    status: { type: 'text', notNull: true, default: "'ACTIVE'" },
    triggered_at: { type: 'timestamptz', notNull: true },
    acknowledged_at: { type: 'timestamptz' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
  });

  // Trigger to broadcast NOTIFY whenever alarm_rules changes
  pgm.sql(`
    CREATE OR REPLACE FUNCTION notify_alarm_rules_updated()
    RETURNS TRIGGER AS $$
    BEGIN
      PERFORM pg_notify('alarm_rules_updated', '');
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER alarm_rules_updated
    AFTER INSERT OR UPDATE OR DELETE ON alarm_rules
    FOR EACH STATEMENT EXECUTE FUNCTION notify_alarm_rules_updated();
  `);

  // Seed rules with explicit UUIDs — lexicographic order = evaluation order.
  // NORM_THRESHOLD (0001) is evaluated before ISOTOPE_IDENTIFIED (0002).
  // This ordering is the "first matching rule wins" contract.
  pgm.sql(`
    INSERT INTO alarm_rules (id, event_type, field, operator, threshold, alarm_subtype)
    VALUES
      (
        '00000000-0000-0000-0000-000000000001',
        'RADIATION_SCAN',
        'peakCountRate',
        '>',
        250,
        'NORM_THRESHOLD'
      ),
      (
        '00000000-0000-0000-0000-000000000002',
        'RADIATION_SCAN',
        'isotope',
        'IS NOT NULL',
        NULL,
        'ISOTOPE_IDENTIFIED'
      );
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const down = (pgm) => {
  pgm.dropTable('alarms');
  pgm.dropTable('alarm_rules');
  pgm.sql('DROP FUNCTION IF EXISTS notify_alarm_rules_updated() CASCADE;');
};
```

**Note on default syntax:** `node-pg-migrate`'s `default` for non-function values must be a raw string including the SQL quotes for text literals. For `status`, the default is `"'ACTIVE'"` — the outer quotes are JavaScript, the inner quotes become the SQL literal `'ACTIVE'`. For function defaults like `gen_random_uuid()`, wrap in `pgm.func(...)` to prevent quoting.

---

## `src/types.ts`

Internal types for this service — not shared via `@vantage/types` because they map directly to DB row shapes.

```typescript
export interface AlarmRule {
  id: string;
  event_type: string;
  field: string;
  operator: string;
  threshold: number | null;
  alarm_subtype: string;
  enabled: boolean;
}
```

---

## `src/logger.ts`

Single pino instance shared by the entire service. Fastify receives this instance directly (see `server.ts`), so `app.log`, `request.log`, and `logger` all share the same configuration. Fastify creates request-scoped children via `logger.child({})` internally, so request logs still carry `reqId`.

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    bindings: (bindings) => ({ ...bindings, service: 'alert-engine' }),
  },
});
```

---

## `src/metrics.ts`

Single prom-client registry for this service. `collectDefaultMetrics` adds Node.js process metrics (memory, CPU, event loop lag) — useful for Grafana. The evaluate histogram is the custom metric called out in the spec.

```typescript
import { Registry, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const evaluateDurationSeconds = new Histogram({
  name: 'alert_engine_evaluate_duration_seconds',
  help: 'End-to-end latency of POST /evaluate (rule eval + DB write)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});
```

---

## `src/evaluate.ts`

The safety-critical core. Pure function — no database access, no network calls, no side effects. Takes the full `DetectionEvent` and the current in-memory rules array. Returns a discriminated union that encodes the invariant: `alarmSubtype` is always present (and typed as `string`, not `string | undefined`) when `alarmTriggered` is true. This is the function under test.

Note: `@vantage/types` also exports an `EvaluateResult` type — that is the HTTP response shape (includes `alarmId`, which comes from the DB insert, not from this function). This file exports `EvalOutput` to avoid naming confusion.

```typescript
import type { DetectionEvent } from '@vantage/types';
import type { AlarmRule } from './types.js';

export type EvalOutput =
  | { alarmTriggered: false }
  | { alarmTriggered: true; alarmSubtype: string };

export function evaluate(
  event: DetectionEvent,
  rules: AlarmRule[],
): EvalOutput {
  const applicable = rules.filter(
    (r) => r.event_type === event.eventType && r.enabled,
  );

  for (const rule of applicable) {
    if (matchesRule(rule, event.payload)) {
      return { alarmTriggered: true, alarmSubtype: rule.alarm_subtype };
    }
  }

  return { alarmTriggered: false };
}

function matchesRule(
  rule: AlarmRule,
  payload: DetectionEvent['payload'],
): boolean {
  const value = (payload as Record<string, unknown>)[rule.field];

  if (rule.operator === '>') {
    return (
      typeof value === 'number' &&
      rule.threshold !== null &&
      value > rule.threshold
    );
  }

  if (rule.operator === 'IS NOT NULL') {
    return value !== null && value !== undefined;
  }

  return false;
}
```

**Why a discriminated union instead of `{ alarmTriggered: boolean; alarmSubtype?: string }`:** The invariant "alarmSubtype is always present when alarmTriggered is true" is load-bearing — the handler relies on it. Encoding it in the type means TypeScript enforces it at compile time and eliminates non-null assertions (`!`) in the handler. For a safety-critical evaluator, the type should express the contract, not just approximate it.

**Why cast payload to `Record<string, unknown>`:** The `field` in each alarm rule is a dynamic string from the database (e.g. `"peakCountRate"`, `"isotope"`). TypeScript cannot statically verify that this string is a valid key of `RadiationPayload`. The cast is intentional — the rule schema defines what fields are valid, and a misconfigured rule simply never matches (the `typeof value === 'number'` guard handles this for `>` operators). This is the correct trade-off for a database-driven rule engine.

---

## `src/evaluate.test.ts`

Seven test cases: the six required by the spec plus a boundary test at `peakCountRate === 250` (the threshold value itself must not trigger). Each test calls `evaluate()` directly — no server, no database, no network.

```typescript
import { describe, it, expect } from 'vitest';
import { evaluate } from './evaluate.js';
import type { DetectionEvent } from '@vantage/types';
import type { AlarmRule } from './types.js';

const normRule: AlarmRule = {
  id: '00000000-0000-0000-0000-000000000001',
  event_type: 'RADIATION_SCAN',
  field: 'peakCountRate',
  operator: '>',
  threshold: 250,
  alarm_subtype: 'NORM_THRESHOLD',
  enabled: true,
};

const isotopeRule: AlarmRule = {
  id: '00000000-0000-0000-0000-000000000002',
  event_type: 'RADIATION_SCAN',
  field: 'isotope',
  operator: 'IS NOT NULL',
  threshold: null,
  alarm_subtype: 'ISOTOPE_IDENTIFIED',
  enabled: true,
};

const allRules = [normRule, isotopeRule];

function makeEvent(overrides: {
  eventType?: DetectionEvent['eventType'];
  peakCountRate?: number;
  isotope?: string | null;
}): DetectionEvent {
  const {
    eventType = 'RADIATION_SCAN',
    peakCountRate = 100,
    isotope = null,
  } = overrides;

  return {
    eventId: 'test-id',
    deviceId: 'PM-01',
    deviceType: 'PORTAL_MONITOR',
    siteId: 'POE-ALPHA',
    timestamp: new Date().toISOString(),
    vendorId: 'VANTAGE',
    eventType,
    platformAlarmStatus: 'CLEAR',
    payload: {
      type: 'RADIATION_SCAN',
      durationMs: 1000,
      peakCountRate,
      backgroundCountRate: 45,
      isotope,
      detectorAlarmSubtype: null,
    },
  };
}

describe('evaluate()', () => {
  it('triggers NORM_THRESHOLD when peakCountRate > 250', () => {
    expect(evaluate(makeEvent({ peakCountRate: 320 }), allRules)).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'NORM_THRESHOLD',
    });
  });

  it('clears when peakCountRate <= 250', () => {
    expect(evaluate(makeEvent({ peakCountRate: 100 }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('triggers ISOTOPE_IDENTIFIED when isotope is not null', () => {
    expect(evaluate(makeEvent({ isotope: 'Cs-137' }), allRules)).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'ISOTOPE_IDENTIFIED',
    });
  });

  it('clears when isotope is null', () => {
    expect(evaluate(makeEvent({ isotope: null }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('does not trigger for XRAY_SCAN against radiation-scoped rules', () => {
    expect(evaluate(makeEvent({ eventType: 'XRAY_SCAN' }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('first matching rule wins — returns NORM_THRESHOLD, not ISOTOPE_IDENTIFIED, when both would match', () => {
    // peakCountRate > 250 AND isotope set — normRule (id: ...0001) sorts before isotopeRule (id: ...0002)
    expect(
      evaluate(makeEvent({ peakCountRate: 320, isotope: 'Cs-137' }), allRules),
    ).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'NORM_THRESHOLD',
    });
  });

  it('does not trigger at the threshold boundary (peakCountRate === 250, rule is strictly >)', () => {
    expect(evaluate(makeEvent({ peakCountRate: 250 }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });
});
```

**Note on XRAY_SCAN test:** `makeEvent` always builds a `RadiationPayload`. The `eventType: 'XRAY_SCAN'` override sets the envelope field while keeping the payload as `RADIATION_SCAN` type. This is intentional — the rule filter uses the envelope `eventType`, not the payload `type`. The test verifies that the envelope field is what scopes rule evaluation, not the payload content.

---

## `src/rules.ts`

Module-level singleton holding the current in-memory rule cache. `setRules` is called on startup (after DB load) and on every LISTEN/NOTIFY event. `getRules` is called by every `/evaluate` request.

```typescript
import type { AlarmRule } from './types.js';

let cache: AlarmRule[] = [];

export function getRules(): AlarmRule[] {
  return cache;
}

export function setRules(rules: AlarmRule[]): void {
  cache = rules;
}
```

---

## `src/db.ts`

Two pg connections: a `Pool` for all queries (alarm record inserts, rule reloads), and a dedicated `Client` for the persistent LISTEN channel. The listener client must be a `Client` (not from the pool) because pool connections can be recycled between queries, which would drop the LISTEN subscription.

```typescript
import { Pool, Client } from 'pg';
import { setRules } from './rules.js';
import { logger } from './logger.js';
import type { AlarmRule } from './types.js';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg returns PostgreSQL NUMERIC columns as strings to avoid float precision loss.
// AlarmRule.threshold is typed as number | null; coerce on load so the in-memory
// cache always has the correct runtime type.
type AlarmRuleRow = Omit<AlarmRule, 'threshold'> & { threshold: string | null };

export async function loadRules(): Promise<void> {
  const result = await pool.query<AlarmRuleRow>(
    `SELECT id, event_type, field, operator, threshold, alarm_subtype, enabled
     FROM alarm_rules
     WHERE enabled = true
     ORDER BY id ASC`,
  );
  setRules(
    result.rows.map((row) => ({
      ...row,
      threshold: row.threshold !== null ? Number(row.threshold) : null,
    })),
  );
  logger.info({ count: result.rows.length }, 'alarm rules loaded');
}

export async function startRuleListener(): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();
  await client.query('LISTEN alarm_rules_updated');

  client.on('notification', () => {
    loadRules().catch((err) => {
      logger.error({ err }, 'failed to reload alarm rules after notification');
    });
  });

  client.on('error', (err) => {
    // Unrecoverable — let the process restart (K8s/tsx watch will handle it)
    logger.error({ err }, 'pg listener connection error — exiting');
    process.exit(1);
  });

  logger.info('listening for alarm_rules_updated notifications');
}
```

---

## `src/server.ts`

Fastify app factory. Passes the shared `logger` instance via `loggerInstance` (the Fastify v5 API for providing a pre-created pino instance — the `logger` option in v5 accepts only a boolean or options object, not a Logger instance). This gives a single pino instance across the service: startup logs, request logs, and background task logs all share the same config. The `/metrics` and `/health` routes are registered here; the `/evaluate` route is registered via plugin.

```typescript
import Fastify from 'fastify';
import { evaluateRoutes } from './routes/evaluate.js';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(evaluateRoutes);

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

## `src/routes/evaluate.ts`

The `POST /evaluate` handler. Calls the pure `evaluate()` function, measures full handler duration (rule eval + DB write) in the histogram, writes the alarm record if triggered, then fires the api-service notification as a background best-effort call.

Because `evaluate()` returns a discriminated union, TypeScript narrows `result.alarmSubtype` to `string` (not `string | undefined`) after the early return — no non-null assertion needed.

```typescript
import type { FastifyInstance } from 'fastify';
import type { DetectionEvent, RadiationPayload } from '@vantage/types';
import { evaluate } from '../evaluate.js';
import { getRules } from '../rules.js';
import { pool } from '../db.js';
import { evaluateDurationSeconds } from '../metrics.js';
import { logger } from '../logger.js';

export async function evaluateRoutes(app: FastifyInstance) {
  app.post<{ Body: DetectionEvent }>('/evaluate', async (request, reply) => {
    const end = evaluateDurationSeconds.startTimer();
    const event = request.body;
    const traceId = request.headers['x-trace-id'] as string | undefined;

    const result = evaluate(event, getRules());

    if (!result.alarmTriggered) {
      end();
      return reply.send({ alarmTriggered: false });
    }

    // TypeScript narrows here: result is { alarmTriggered: true; alarmSubtype: string }

    const radiationPayload =
      event.payload.type === 'RADIATION_SCAN'
        ? (event.payload as RadiationPayload)
        : null;

    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO alarms
         (device_id, site_id, event_type, alarm_subtype, peak_count_rate, isotope, triggered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        event.deviceId,
        event.siteId,
        event.eventType,
        result.alarmSubtype,
        radiationPayload?.peakCountRate ?? null,
        radiationPayload?.isotope ?? null,
        event.timestamp,
      ],
    );

    const alarmId = insertResult.rows[0].id;

    end();

    // Best-effort: fire and forget. api-service does not exist until Phase 6.
    notifyApiService(
      { alarmId, alarmSubtype: result.alarmSubtype, event },
      traceId,
    );

    return reply.send({
      alarmTriggered: true,
      alarmId,
      alarmSubtype: result.alarmSubtype,
    });
  });
}

interface NotifyPayload {
  alarmId: string;
  alarmSubtype: string;
  event: DetectionEvent;
}

function notifyApiService(
  payload: NotifyPayload,
  traceId: string | undefined,
): void {
  const apiServiceUrl = process.env.API_SERVICE_URL;
  if (!apiServiceUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  fetch(`${apiServiceUrl}/api/internal/alarms/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(traceId ? { 'X-Trace-Id': traceId } : {}),
    },
    body: JSON.stringify({
      alarmId: payload.alarmId,
      alarmSubtype: payload.alarmSubtype,
      deviceId: payload.event.deviceId,
      siteId: payload.event.siteId,
      timestamp: payload.event.timestamp,
    }),
    signal: controller.signal,
  })
    .catch((err: unknown) => {
      logger.warn(
        { err, alarmId: payload.alarmId, traceId },
        'api-service notify failed — alarm persisted, notification dropped',
      );
    })
    .finally(() => clearTimeout(timeout));
}
```

**Why `notifyApiService` does not `await`:** The response to ingestion-service must not be held while waiting for api-service. The alarm is already written to PostgreSQL at this point. api-service notification is a WebSocket push enhancement — losing it does not affect alarm correctness. The 2-second timeout ensures the background request does not leak indefinitely.

---

## `src/index.ts`

Entry point. Runs in sequence: migrations → rule load → listener → server. Each step is async; a failure in any step exits the process.

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import migrate from 'node-pg-migrate';
import { loadRules, startRuleListener } from './db.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }

  await migrate({
    databaseUrl: process.env.DATABASE_URL,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg) => logger.debug({ migration: true }, msg),
  });
  logger.info('database migrations applied');

  await loadRules();
  await startRuleListener();

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3002);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'alert-engine ready');
}

main().catch((err) => {
  logger.error({ err }, 'alert-engine startup failed');
  process.exit(1);
});
```

**`host: '0.0.0.0'`:** Required for Docker/K3s — Fastify defaults to `127.0.0.1` which is not reachable from other containers.

**`log: (msg) => logger.debug({ migration: true }, msg)`:** node-pg-migrate prints human-readable text to its `log` callback. Routing it through pino at `debug` level keeps all stdout as structured JSON (no raw text mixed in), while still making migration details available when debugging (`LOG_LEVEL=debug`). At the default `info` level these lines are suppressed; the "database migrations applied" info log after `migrate()` resolves is all that appears in normal operation.

---

## Verification Steps

Run these in order after implementing all files.

**1. Install dependencies**
```bash
pnpm install
```
Expected: `node_modules/@vantage/alert-engine` does not exist (this service is not a library), but `apps/alert-engine/node_modules` is populated. `node_modules/@vantage/types` symlink remains valid.

**2. Typecheck**
```bash
pnpm typecheck
```
Expected: exits 0. The root `tsconfig.json` includes `apps/*/src/**/*.ts` — this now covers alert-engine. `evaluate.test.ts` is included because the pattern matches.

**3. Lint**
```bash
pnpm lint
```
Expected: exits 0. No ESLint violations.

**4. Unit tests**
```bash
pnpm test
```
Expected: 7 tests pass. Vitest discovers `apps/alert-engine/src/evaluate.test.ts` via the root `vitest.config.ts` pattern `apps/*/src/**/*.test.ts`.

**5. Start infra (if not already running)**
```bash
pnpm infra:up
```

**6. Start alert-engine locally**
```bash
cd apps/alert-engine && pnpm start
```
Expected: four log lines in sequence — "database migrations applied", "alarm rules loaded" with `count: 2`, "listening for alarm_rules_updated notifications", then "alert-engine ready" with `port: 3002`.

**7. Verify POST /evaluate — alarm case**
```bash
curl -s -X POST http://localhost:3002/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-001",
    "deviceId": "PM-01",
    "deviceType": "PORTAL_MONITOR",
    "siteId": "POE-ALPHA",
    "timestamp": "2026-04-25T10:00:00.000Z",
    "vendorId": "VANTAGE",
    "eventType": "RADIATION_SCAN",
    "platformAlarmStatus": "CLEAR",
    "payload": {
      "type": "RADIATION_SCAN",
      "durationMs": 2000,
      "peakCountRate": 320,
      "backgroundCountRate": 45,
      "isotope": null,
      "detectorAlarmSubtype": null
    }
  }'
```
Expected response:
```json
{"alarmTriggered":true,"alarmId":"<uuid>","alarmSubtype":"NORM_THRESHOLD"}
```

Alert-engine will log a warn about api-service notify failing — this is expected until Phase 6.

**8. Verify alarm record in PostgreSQL**
```bash
docker compose exec postgres psql -U vantage -d vantage -c "SELECT id, device_id, alarm_subtype, status FROM alarms;"
```
Expected: one row with `device_id: PM-01`, `alarm_subtype: NORM_THRESHOLD`, `status: ACTIVE`.

**9. Verify POST /evaluate — clear case**
```bash
curl -s -X POST http://localhost:3002/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-002",
    "deviceId": "PM-01",
    "deviceType": "PORTAL_MONITOR",
    "siteId": "POE-ALPHA",
    "timestamp": "2026-04-25T10:00:01.000Z",
    "vendorId": "VANTAGE",
    "eventType": "RADIATION_SCAN",
    "platformAlarmStatus": "CLEAR",
    "payload": {
      "type": "RADIATION_SCAN",
      "durationMs": 2000,
      "peakCountRate": 100,
      "backgroundCountRate": 45,
      "isotope": null,
      "detectorAlarmSubtype": null
    }
  }'
```
Expected response: `{"alarmTriggered":false}`. No new row in `alarms` table.

**10. Verify Prometheus metrics**
```bash
curl -s http://localhost:3002/metrics | grep alert_engine_evaluate_duration
```
Expected: histogram lines with `_bucket`, `_count`, `_sum` suffixes.

**11. Verify rule hot-reload**
```bash
# Update the threshold in PostgreSQL — NOTIFY fires automatically via the trigger
docker compose exec postgres psql -U vantage -d vantage \
  -c "UPDATE alarm_rules SET threshold = 200 WHERE alarm_subtype = 'NORM_THRESHOLD';"
```
Expected: alert-engine logs "alarm rules loaded" with `count: 2` within ~1 second (the LISTEN/NOTIFY fires the reload). Then a `peakCountRate: 210` event should now trigger NORM_THRESHOLD. Reset the threshold to 250 when done.

---

## Decisions

**Fastify over Express or Hono:** Fastify is the appropriate choice for TypeScript microservices in 2026. In Fastify v5, a pre-created pino logger instance is passed via the `loggerInstance` option — not `logger` (which in v5 accepts only a boolean or options object). `Fastify({ loggerInstance: logger })` means `app.log`, `request.log` (a pino child), and the standalone `logger` all share one configuration. Schema-based request/response typing is built in. Fastify 5.x is the current stable major (v5.8.5 at time of writing). Express is too old-school for a demo targeting senior engineers at a modern company. Hono is primarily for edge runtimes and lacks the maturity for server-side Node.js services.

**`pg` over Prisma or Drizzle:** The schema is simple (two tables, straightforward queries). An ORM adds compile-step complexity and opaque query generation. `pg` with raw SQL makes the alarm insert and rule load queries explicit — important for demonstrating DB literacy in an interview context. `node-pg-migrate` is the standard migration tool for `pg`-based projects.

**Programmatic migration on startup:** `node-pg-migrate`'s Node API runs migrations inline before the server starts. This avoids a separate migration-runner step in the Dockerfile CMD and ensures the server never starts against a stale schema in K3s (where there's no manual pre-deploy step). The `pgmigrations` table makes it idempotent — re-running on each deploy is safe.

**Explicit seed UUIDs for rule ordering:** `ORDER BY id ASC` on UUIDs gives lexicographic order, which is deterministic. Using `'00000000-0000-0000-0000-000000000001'` and `'...0002'` makes the seed ordering explicit and verifiable. The alternative — a `priority` column — adds schema complexity not required by the spec. The downside: operators adding rules via SQL must be aware that UUID order determines evaluation priority (documented in README for completeness).

**Dedicated `pg.Client` for LISTEN:** Connection pools recycle connections, which would silently drop the LISTEN subscription when the connection is returned. A single persistent `Client` connection exclusively for LISTEN/NOTIFY avoids this. The pool handles all other queries.

**Process exit on listener error:** If the LISTEN connection drops unrecoverably, the rules cache may be stale. Exiting is the correct failure mode — K8s restarts the pod, which re-runs migrations (idempotent), reloads rules, and re-establishes the listener. Silent stale-cache operation is worse than a visible restart.

**`notifyApiService` fires and forgets:** The HTTP response to ingestion-service must not be blocked on api-service availability. The alarm is written to PostgreSQL before the notify is attempted. The 2-second timeout prevents the background promise from leaking. The warn log makes the failure visible in `kubectl logs` without propagating it. `logger` from `logger.ts` is used directly — there is no need to pass `app` as a parameter since the unified logger is already a module-level import.

**`host: '0.0.0.0'` in `app.listen`:** Fastify defaults to localhost. In a Docker container or K3s pod, localhost is not reachable from other pods. `0.0.0.0` binds on all interfaces, which is required for container networking. This is always correct for a containerised service.

**`evaluate()` filters by `r.enabled`:** The DB query already filters `WHERE enabled = true`, so the in-memory cache only contains enabled rules. The redundant check in `evaluate()` makes the pure function self-contained — it behaves correctly regardless of how it is called, which is important for test clarity and future resilience.

**`EvalOutput` discriminated union:** The `evaluate()` function's return type uses a discriminated union rather than `{ alarmTriggered: boolean; alarmSubtype?: string }`. When `alarmTriggered: true`, TypeScript narrows `alarmSubtype` to `string` — no non-null assertion needed in the handler. The name `EvalOutput` (not `EvaluateResult`) avoids shadowing the shared `EvaluateResult` type from `@vantage/types`, which is the HTTP response shape and includes `alarmId`.

**`threshold` coercion in `loadRules`:** PostgreSQL `NUMERIC` columns are returned as JavaScript strings by `pg` to avoid float precision loss. `AlarmRule.threshold` is typed as `number | null`. The `AlarmRuleRow` intermediate type captures the true runtime shape from the query (`threshold: string | null`), and `Number()` coerces it before writing to the cache. The `matchesRule` comparison `value > rule.threshold` then operates on `number > number` as TypeScript claims.
