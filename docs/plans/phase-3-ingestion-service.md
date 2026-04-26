---
status: Implemented
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-2-alert-engine.md
---

# Phase 3: ingestion-service

## Objective

Build the `ingestion-service`: a Fastify HTTP server that normalises inbound `DetectionEvent` objects, calls `alert-engine POST /evaluate` synchronously on the alarm path, enqueues the enriched event to a BullMQ Redis-backed queue for async Elasticsearch indexing, and writes device heartbeat state to Redis with a 30-second TTL.

Phase 2 produced alert-engine with its established `POST /evaluate` contract: takes a `DetectionEvent`, returns `EvaluateResult`. Phase 3 produces the first caller of that contract. No other services exist yet — api-service (Phase 6) and event-store-service (Phase 5) are downstream; they don't need to exist to verify Phase 3.

Phase 3 also completes the end-to-end idempotency story across all three persistence layers. This requires a retroactive change to alert-engine (see next section) before implementing ingestion-service.

When this phase is complete:
- `pnpm test` runs all 15 integration test assertions and passes
- ingestion-service starts on port 3001 against docker-compose
- `curl -X POST localhost:3001/events` with a radiation payload calls alert-engine and returns 202
- `curl -X POST localhost:3001/heartbeats` writes to Redis and returns 204
- A BullMQ job is visible in Redis after posting an event

**Incoming request shapes:** `POST /events` accepts a `DetectionEvent`; `POST /heartbeats` accepts a `Heartbeat`. Both interfaces are defined in [`packages/types/src/index.ts`](../../packages/types/src/index.ts).

---

## Prerequisite: Retroactive Phase 2 Fix

Before implementing Phase 3, alert-engine needs one schema change and one query change. Without this fix, a network failure between alert-engine's PostgreSQL write and its HTTP response to ingestion-service would cause a duplicate alarm row on client retry.

### Migration change

Add `event_id TEXT UNIQUE NOT NULL` to the `alarms` table. Since no production data exists, update the CREATE TABLE statement in the initial migration (`apps/alert-engine/migrations/1745000000000_initial.js`) directly:

```js
// Add to the CREATE TABLE alarms statement:
event_id TEXT UNIQUE NOT NULL,
```

### `apps/alert-engine/src/routes/evaluate.ts` change

Replace the `evaluateRoutes` function with the version below. The structural changes are: `event_id` added to the INSERT column list; the single `pool.query` INSERT replaced with a `pool.connect()` transaction block; `end()` moved to after the transaction block so the histogram records total latency including the DB write. `notifyApiService` and `return reply.send(...)` are unchanged.

```typescript
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

    const radiationPayload =
      event.payload.type === 'RADIATION_SCAN'
        ? (event.payload as RadiationPayload)
        : null;

    const client = await pool.connect();
    let alarmId: string;
    try {
      await client.query('BEGIN');

      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO alarms
           (event_id, device_id, site_id, event_type, alarm_subtype,
            peak_count_rate, isotope, triggered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [
          event.eventId,
          event.deviceId,
          event.siteId,
          event.eventType,
          result.alarmSubtype,
          radiationPayload?.peakCountRate ?? null,
          radiationPayload?.isotope ?? null,
          event.timestamp,
        ],
      );

      if (insertResult.rows.length === 0) {
        // Idempotent re-evaluation: alarm already exists for this eventId.
        // Return the existing alarmId without creating a duplicate row.
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM alarms WHERE event_id = $1',
          [event.eventId],
        );
        alarmId = existing.rows[0].id;
      } else {
        alarmId = insertResult.rows[0].id;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

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
```

The `pool.connect()` / `client.release()` pattern is required here because `pool.query` does not support multi-statement transactions — it checks out and returns a connection per call. The `finally` block guarantees the connection is returned to the pool even if `ROLLBACK` throws. `ROLLBACK` uses `.catch(() => {})` because if the connection is dead, `ROLLBACK` itself throws and would swallow the original error — a dead connection means PostgreSQL has already rolled back the transaction, so the `.catch` silently discards a redundant failure.

---

## File Tree

```
apps/ingestion-service/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            # entry point: env checks → buildServer → listen
    ├── server.ts           # Fastify app factory: registers routes, /metrics, /health
    ├── queue.ts            # BullMQ Queue singleton (detection-events)
    ├── redis.ts            # IORedis singleton for heartbeat hash writes
    ├── metrics.ts          # prom-client registry + ingestion_events_total counter
    ├── logger.ts           # shared pino instance
    ├── events.test.ts      # integration tests — alarm path (6 assertions)
    ├── heartbeats.test.ts  # integration tests — heartbeat path (2 assertions)
    └── routes/
        ├── events.ts       # POST /events handler
        └── heartbeats.ts   # POST /heartbeats handler
```

---

## `apps/ingestion-service/package.json`

```json
{
  "name": "@vantage/ingestion-service",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx --env-file=../../.env src/index.ts",
    "dev": "tsx watch --env-file=../../.env src/index.ts"
  },
  "dependencies": {
    "@vantage/types": "workspace:*",
    "bullmq": "^5.0.0",
    "fastify": "^5.0.0",
    "ioredis": "^5.0.0",
    "pino": "^10.0.0",
    "prom-client": "^15.0.0"
  },
  "devDependencies": {
    "msw": "^2.0.0",
    "tsx": "^4.0.0",
    "vitest": "^4.0.0"
  }
}
```

`bullmq` and `ioredis` ship their own TypeScript types — no `@types/*` needed for them. `msw` is a devDependency because it is only used in the integration test.

---

## `apps/ingestion-service/tsconfig.json`

Identical pattern to Phase 2.

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

Same pattern as alert-engine — single pino instance shared across the service.

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    bindings: (bindings) => ({ ...bindings, service: 'ingestion-service' }),
  },
});
```

---

## `src/metrics.ts`

Registry with default Node.js metrics plus the `ingestion_events_total` counter. This counter is labelled by `eventType` and `platformAlarmStatus` — both are low-cardinality, bounded label sets. Per-device activity queries are served by Elasticsearch (Phase 5); using `deviceId` as a Prometheus label would be high-cardinality and is the wrong tool for per-device views.

```typescript
import { Registry, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const ingestionEventsTotal = new Counter({
  name: 'ingestion_events_total',
  help: 'Total detection events processed by ingestion-service',
  labelNames: ['eventType', 'platformAlarmStatus'],
  registers: [registry],
});
```

---

## `src/queue.ts`

BullMQ Queue singleton. `maxRetriesPerRequest: null` is required by BullMQ — it needs the ioredis connection to not apply per-request retry logic (BullMQ manages its own job retry lifecycle). Without it, BullMQ throws at startup.

Both `connection` and `queue` are exported. `connection` is exported so `index.ts` can call `connection.quit()` during graceful shutdown — when you pass an IORedis instance to BullMQ rather than connection options, BullMQ does not close the connection on `queue.close()`. The caller owns the connection.

The Queue is created at module evaluation time. In tests, `vi.mock('bullmq')` replaces the Queue constructor with a mock before this module is evaluated, so no real Redis connection is attempted.

```typescript
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';

export const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const queue = new Queue('detection-events', { connection });
```

---

## `src/redis.ts`

Separate IORedis instance for heartbeat hash writes. BullMQ owns its connection; this one is for direct Redis commands (`HSET`, `EXPIRE`).

```typescript
import { Redis } from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
```

---

## `src/routes/events.ts`

The `POST /events` handler. The two-path flow is sequentially ordered but failure-independent:
1. **Alarm path (sync):** POST to alert-engine. If unreachable or 5xx → 503 immediately; BullMQ enqueue does not happen.
2. **Indexing path (best-effort):** Enqueue enriched event to BullMQ. If Redis is down and `queue.add` throws, the exception is caught, logged, and 202 is returned regardless — the alarm is already durable in PostgreSQL, and a 500 would cause the client to retry, producing unnecessary duplicate alarm evaluation round-trips. `eventId` is passed as the BullMQ job ID so concurrent retries that do reach BullMQ are deduplicated.

```typescript
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DetectionEvent, EvaluateResult } from '@vantage/types';
import { queue } from '../queue.js';
import { ingestionEventsTotal } from '../metrics.js';
import { logger } from '../logger.js';

export async function eventsRoutes(app: FastifyInstance) {
  app.post<{ Body: DetectionEvent }>('/events', async (request, reply) => {
    const body = request.body;

    if (!body?.deviceId || !body?.eventType || !body?.payload || !body?.timestamp) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }

    const traceId =
      (request.headers['x-trace-id'] as string | undefined) ?? randomUUID();

    // Normalise: device IDs to uppercase, timestamp to strict ISO8601
    let normalizedTimestamp: string;
    try {
      normalizedTimestamp = new Date(body.timestamp).toISOString();
    } catch {
      return reply.status(400).send({ error: 'Invalid timestamp' });
    }

    const event: DetectionEvent = {
      ...body,
      deviceId: body.deviceId.toUpperCase(),
      timestamp: normalizedTimestamp,
    };

    // Alarm path — synchronous. Failure here is immediate and visible (503).
    const alertEngineUrl = process.env.ALERT_ENGINE_URL;
    if (!alertEngineUrl) {
      logger.error({ traceId }, 'ALERT_ENGINE_URL not configured');
      return reply.status(503).send({ error: 'Alert engine not configured' });
    }

    let evaluateResult: EvaluateResult;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${alertEngineUrl}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': traceId,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.error(
          { traceId, status: response.status },
          'alert-engine returned error',
        );
        return reply.status(503).send({ error: 'Alert engine evaluation failed' });
      }

      evaluateResult = (await response.json()) as EvaluateResult;
    } catch (err) {
      clearTimeout(timeout);
      logger.error({ err, traceId }, 'alert-engine unreachable');
      return reply.status(503).send({ error: 'Alert engine unreachable' });
    }

    // Enrich — ingestion-service unconditionally overwrites platformAlarmStatus
    // with the platform's verdict. The simulator sends 'CLEAR' as a placeholder.
    const enrichedEvent: DetectionEvent = {
      ...event,
      platformAlarmStatus: evaluateResult.alarmTriggered ? 'ALARM' : 'CLEAR',
    };

    // Indexing path — best-effort. Alarm is already durable in PostgreSQL.
    // jobId makes the enqueue idempotent: BullMQ will not add a duplicate job
    // while one with the same ID is already in the queue.
    try {
      await queue.add('detection-event', enrichedEvent, { jobId: enrichedEvent.eventId });
    } catch (err) {
      logger.error({ err, traceId }, 'enqueue failed — alarm persisted, event not indexed');
    }

    ingestionEventsTotal.inc({
      eventType: enrichedEvent.eventType,
      platformAlarmStatus: enrichedEvent.platformAlarmStatus,
    });

    logger.info(
      {
        traceId,
        deviceId: enrichedEvent.deviceId,
        platformAlarmStatus: enrichedEvent.platformAlarmStatus,
      },
      'event processed',
    );

    return reply.status(202).header('X-Trace-Id', traceId).send({ received: true });
  });
}
```

---

## `src/routes/heartbeats.ts`

`POST /heartbeats` handler. Validates `deviceId`, `timestamp`, and `backgroundCountRate` before processing. Normalises `timestamp` to strict ISO8601 — consistent with the events route, and necessary because `api-service GET /api/devices` (Phase 6) will surface `lastSeen` directly to the UI. Writes device state as a Redis hash and sets a 30-second TTL. When the TTL expires, the key is gone. `GET /api/devices` (api-service, Phase 6) interprets an absent key as `status: 'OFFLINE'` — no explicit "go offline" message is needed.

```typescript
import type { FastifyInstance } from 'fastify';
import type { Heartbeat } from '@vantage/types';
import { redis } from '../redis.js';
import { logger } from '../logger.js';

export async function heartbeatsRoutes(app: FastifyInstance) {
  app.post<{ Body: Heartbeat }>('/heartbeats', async (request, reply) => {
    const body = request.body;

    if (!body?.deviceId || !body?.timestamp || body?.backgroundCountRate == null) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }

    let normalizedTimestamp: string;
    try {
      normalizedTimestamp = new Date(body.timestamp).toISOString();
    } catch {
      return reply.status(400).send({ error: 'Invalid timestamp' });
    }

    const key = `device:state:${body.deviceId}`;

    await redis
      .pipeline()
      .hset(key, {
        lastSeen: normalizedTimestamp,
        backgroundCountRate: String(body.backgroundCountRate),
        deviceType: body.deviceType,
        status: 'ONLINE',
      })
      .expire(key, 30)
      .exec();

    logger.debug({ deviceId: body.deviceId }, 'heartbeat received');

    return reply.status(204).send();
  });
}
```

**`backgroundCountRate` as string:** Redis hashes store values as strings. `body.backgroundCountRate` is a number. Explicitly converting to `String()` makes the type intent clear to both the reader and TypeScript. `api-service GET /api/devices` (Phase 6) parses it back with `Number()`.

**Pipeline for atomicity:** `HSET` and `EXPIRE` are sent as a single pipeline batch — one round trip, both commands applied atomically. Without a pipeline, a crash between the two commands leaves the key without a TTL and the device shows permanently `ONLINE`. Heartbeats arrive every 5 seconds so it is self-healing in practice, but the pipeline is a one-line improvement that eliminates the failure mode entirely.

---

## `src/server.ts`

Fastify app factory. Registers both route plugins, metrics, and health endpoints.

```typescript
import Fastify from 'fastify';
import { eventsRoutes } from './routes/events.js';
import { heartbeatsRoutes } from './routes/heartbeats.js';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(eventsRoutes);
  await app.register(heartbeatsRoutes);

  app.get('/metrics', async (_request, reply) => {
    const output = await registry.metrics();
    return reply.header('Content-Type', registry.contentType).send(output);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
```

---

## `src/index.ts`

Entry point. Checks required env vars before starting — fails fast and loud rather than failing silently on first request. `buildServer()` itself does not check env vars; it is also called in tests where env vars are set before invocation.

Signal handlers are registered after `app.listen()` so they can reference the live app instance. SIGINT handles `Ctrl+C` in local dev; SIGTERM is what K8s sends when terminating a pod. The shutdown sequence is: stop accepting new HTTP requests (`app.close()`), drain BullMQ queue state (`queue.close()`), then close the two IORedis connections. Shutdown failures fall through to `process.exit(1)` so the process never hangs.

**Connection ownership:** `queue.close()` closes BullMQ's internal bookkeeping but does not close the IORedis instance passed to it — the caller owns that connection. `connection.quit()` closes it explicitly. `redis.quit()` closes the separate heartbeat connection.

```typescript
import { buildServer } from './server.js';
import { queue, connection } from './queue.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

async function main() {
  const missing = ['REDIS_URL', 'ALERT_ENGINE_URL'].filter(
    (v) => !process.env[v],
  );
  if (missing.length > 0) {
    logger.error({ missing }, 'required env vars not set');
    process.exit(1);
  }

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'ingestion-service ready');

  const shutdown = async () => {
    logger.info('shutdown signal received — closing gracefully');
    await app.close();
    await queue.close();
    await connection.quit();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
}

main().catch((err) => {
  logger.error({ err }, 'ingestion-service startup failed');
  process.exit(1);
});
```

---

## `src/events.test.ts`

Integration tests for the alarm path. Six assertions: the original three path-ordering contracts, plus three new tests covering the idempotency and observability additions.

**Testing strategy:** msw intercepts the outbound `fetch` call to alert-engine — no real alert-engine needed. `vi.mock('bullmq')` replaces the Queue constructor with a mock — no real Redis needed. `app.inject` drives the Fastify handler without opening a port.

**ESM hoisting:** In Vitest ESM mode, `vi.mock` calls are hoisted above import statements automatically. `vi.hoisted(() => ...)` creates values that are safe to reference inside a hoisted `vi.mock` factory, because `vi.hoisted` itself is also hoisted. Without `vi.hoisted`, `mockQueueAdd` would be `undefined` inside the `vi.mock` factory due to the temporal dead zone.

```typescript
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import type { DetectionEvent } from '@vantage/types';

// vi.hoisted creates the spy in the hoisted scope — it is available when
// the vi.mock factory below runs, because both are hoisted by Vitest's transform
// above all static import statements.
const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// vi.mock calls are hoisted by Vitest above all static imports. When the module
// graph is evaluated (server.ts → events.ts → queue.ts → bullmq / redis.ts → ioredis),
// these mocks are already registered. No real Redis connections are made.
vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// heartbeatsRoutes imports redis.ts which instantiates Redis at module eval time.
// Mocking ioredis prevents a real connection attempt even though no heartbeat
// requests are made in these tests.
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    hset: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    pipeline: vi.fn().mockReturnValue({
      hset: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));

import { buildServer } from './server.js';

// ALERT_ENGINE_URL is read at request time (inside the route handler), not at
// module evaluation time, so it does not need to precede the import.
// REDIS_URL is read by mocked constructors that ignore it.
process.env.ALERT_ENGINE_URL = 'http://alert-engine-test';
process.env.REDIS_URL = 'redis://localhost:6379';

const mswServer = setupServer();

describe('POST /events — alarm path ordering', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    mswServer.listen();
    app = await buildServer();
  });

  afterEach(() => {
    mswServer.resetHandlers();
    mockQueueAdd.mockClear();
  });

  afterAll(async () => {
    await app.close();
    mswServer.close();
  });

  it('enqueues with platformAlarmStatus ALARM when alert-engine returns alarmTriggered: true', async () => {
    mswServer.use(
      http.post('http://alert-engine-test/evaluate', () =>
        HttpResponse.json({
          alarmTriggered: true,
          alarmId: 'alarm-uuid-001',
          alarmSubtype: 'NORM_THRESHOLD',
        }),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: makeEvent(),
    });

    expect(response.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, enqueuedPayload, jobOptions] = mockQueueAdd.mock.calls[0] as [
      string,
      DetectionEvent,
      { jobId: string },
    ];
    expect(enqueuedPayload.platformAlarmStatus).toBe('ALARM');
    expect(enqueuedPayload.deviceId).toBe('PM-01'); // normalised to uppercase
    expect(jobOptions.jobId).toBe(enqueuedPayload.eventId);
  });

  it('enqueues with platformAlarmStatus CLEAR when alert-engine returns alarmTriggered: false', async () => {
    mswServer.use(
      http.post('http://alert-engine-test/evaluate', () =>
        HttpResponse.json({ alarmTriggered: false }),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: makeEvent(),
    });

    expect(response.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
    const [, enqueuedPayload, jobOptions] = mockQueueAdd.mock.calls[0] as [
      string,
      DetectionEvent,
      { jobId: string },
    ];
    expect(enqueuedPayload.platformAlarmStatus).toBe('CLEAR');
    expect(enqueuedPayload.deviceId).toBe('PM-01'); // normalised to uppercase
    expect(jobOptions.jobId).toBe(enqueuedPayload.eventId);
  });

  it('returns 503 and does not enqueue when alert-engine returns 503', async () => {
    mswServer.use(
      http.post('http://alert-engine-test/evaluate', () =>
        HttpResponse.json({ error: 'internal error' }, { status: 503 }),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: makeEvent(),
    });

    expect(response.statusCode).toBe(503);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('returns 202 even when BullMQ enqueue fails', async () => {
    mswServer.use(
      http.post('http://alert-engine-test/evaluate', () =>
        HttpResponse.json({ alarmTriggered: false }),
      ),
    );

    mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: makeEvent(),
    });

    expect(response.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledOnce();
  });

  it('propagates inbound X-Trace-Id to response header', async () => {
    mswServer.use(
      http.post('http://alert-engine-test/evaluate', () =>
        HttpResponse.json({ alarmTriggered: false }),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      headers: { 'x-trace-id': 'trace-round-trip-001' },
      payload: makeEvent(),
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['x-trace-id']).toBe('trace-round-trip-001');
  });

  it('returns 400 when timestamp is missing', async () => {
    const { timestamp: _omitted, ...rest } = makeEvent();

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: rest as unknown as DetectionEvent,
    });

    expect(response.statusCode).toBe(400);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

function makeEvent(): DetectionEvent {
  return {
    eventId: 'test-event-001',
    deviceId: 'pm-01', // lowercase — asserted as 'PM-01' in the enqueued payload
    deviceType: 'PORTAL_MONITOR',
    siteId: 'POE-ALPHA',
    timestamp: '2026-04-26T10:00:00.000Z',
    vendorId: 'VANTAGE',
    eventType: 'RADIATION_SCAN',
    platformAlarmStatus: 'CLEAR', // simulator placeholder — ingestion overwrites this
    payload: {
      type: 'RADIATION_SCAN',
      durationMs: 2000,
      peakCountRate: 320,
      backgroundCountRate: 45,
      isotope: null,
      detectorAlarmSubtype: null,
    },
  };
}
```

---

## `src/heartbeats.test.ts`

Integration tests for the heartbeat route. Two assertions: happy-path pipeline execution and validation rejection.

No MSW setup is needed — the heartbeat route makes no outbound HTTP calls. BullMQ is still mocked because `server.ts` registers `eventsRoutes`, which imports `queue.ts` at module evaluation time.

`mockPipelineExec` is the single spy that matters: it confirms the Redis pipeline completed, which implies both `HSET` and `EXPIRE` were chained before it.

```typescript
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Heartbeat } from '@vantage/types';

const mockPipelineExec = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    pipeline: vi.fn().mockReturnValue({
      hset: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: mockPipelineExec,
    }),
    quit: vi.fn().mockResolvedValue('OK'),
  })),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { buildServer } from './server.js';

process.env.ALERT_ENGINE_URL = 'http://alert-engine-test';
process.env.REDIS_URL = 'redis://localhost:6379';

describe('POST /heartbeats', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterEach(() => {
    mockPipelineExec.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 204 and executes Redis pipeline when heartbeat is valid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/heartbeats',
      payload: makeHeartbeat(),
    });

    expect(response.statusCode).toBe(204);
    expect(mockPipelineExec).toHaveBeenCalledOnce();
  });

  it('returns 400 when deviceId is missing', async () => {
    const { deviceId: _omitted, ...rest } = makeHeartbeat();

    const response = await app.inject({
      method: 'POST',
      url: '/heartbeats',
      payload: rest as unknown as Heartbeat,
    });

    expect(response.statusCode).toBe(400);
    expect(mockPipelineExec).not.toHaveBeenCalled();
  });
});

function makeHeartbeat(): Heartbeat {
  return {
    deviceId: 'PM-01',
    deviceType: 'PORTAL_MONITOR',
    timestamp: '2026-04-26T10:00:00.000Z',
    backgroundCountRate: 45,
    status: 'ONLINE',
  };
}
```

---

## Integration Test Architecture Notes

**Why `vi.hoisted` is required here:**

`vi.mock` is hoisted by Vitest above all `import` statements. A factory function passed to `vi.mock` runs during that hoisted execution. If `mockQueueAdd` were declared as a regular `const` (not wrapped in `vi.hoisted`), it would be `undefined` when the factory runs — because regular `const` declarations are not hoisted into the temporal dead zone at the time the `vi.mock` factory executes. `vi.hoisted(() => vi.fn())` creates the spy in a separate execution context that is hoisted alongside `vi.mock`, so it is defined when the factory references it. The same logic applies to `mockPipelineExec` in `heartbeats.test.ts`.

**Why `vi.mock('ioredis')` is required even though `events.test.ts` only hits `/events`:**

`server.ts` registers `heartbeatsRoutes`, which imports `redis.ts`, which imports and instantiates `IORedis` at module evaluation time. Without mocking ioredis, `buildServer()` would try to create a real Redis connection during the test. The mock ensures the constructor is intercepted.

The ioredis mock includes a `pipeline()` method that returns a chainable mock — required because `heartbeatsRoutes` uses `redis.pipeline().hset(...).expire(...).exec()`. Even though no heartbeat requests are made in `events.test.ts`, the mock must match the interface the code calls at request time.

**Why `heartbeats.test.ts` has a separate, simpler ioredis mock:**

`events.test.ts` mocks ioredis defensively (all methods present) because it exercises `buildServer()` which registers both routes. `heartbeats.test.ts` uses the same approach but only needs `pipeline` and `quit`. The mocks are kept in separate files so each test module controls its own spy references — sharing mocks across test files via a setup file would make spy isolation (`.mockClear()` in `afterEach`) harder to reason about.

**Why `heartbeats.test.ts` does not use MSW:**

The heartbeat route makes no outbound HTTP calls. MSW setup in `heartbeats.test.ts` would be dead code. The absence of MSW is intentional, not an oversight.

**Why msw over nock:**

nock intercepts at the Node.js `http` module level. Native `fetch` in Node 22 uses `undici` internally — nock does not intercept undici. msw v2 uses `@mswjs/interceptors` which hooks into undici directly, so it intercepts native `fetch` requests correctly.

**Why `app.inject` over `supertest`:**

Fastify's `inject` method drives the request through the full routing and plugin chain without binding to a port. No port conflict, no network, no `supertest` dependency. The response object has `.statusCode` and `.json()` — same ergonomics as a real HTTP response.

---

## Verification Steps

**1. Apply the Phase 2 retroactive fix**

Update `apps/alert-engine/migrations/1745000000000_initial.js` to add `event_id TEXT UNIQUE NOT NULL` to the `alarms` CREATE TABLE statement. Update `apps/alert-engine/src/routes/evaluate.ts` with the transaction-wrapped INSERT pattern shown in the Prerequisite section above.

**2. Install and typecheck**
```bash
pnpm install
pnpm typecheck
```
Expected: exits 0.

**3. Lint**
```bash
pnpm lint
```
Expected: exits 0.

**4. Integration tests**
```bash
pnpm test
```
Expected: 15 tests pass — 7 from Phase 2 evaluate unit tests + 6 from Phase 3 events integration tests + 2 from Phase 3 heartbeats integration tests.

**5. Start infra (if not already running)**
```bash
pnpm infra:up
```

**6. Start alert-engine (Phase 2 must already be running)**
```bash
# In a separate terminal:
cd apps/alert-engine && pnpm start
```
Expected: alert-engine ready on port 3002.

**7. Start ingestion-service**
```bash
cd apps/ingestion-service && pnpm start
```
Expected log lines: "ingestion-service ready" with `port: 3001`.

**8. POST a detection event — alarm case**
```bash
curl -si -X POST http://localhost:3001/events \
  -H "Content-Type: application/json" \
  -H "X-Trace-Id: manual-trace-001" \
  -d '{
    "eventId": "test-001",
    "deviceId": "pm-01",
    "deviceType": "PORTAL_MONITOR",
    "siteId": "POE-ALPHA",
    "timestamp": "2026-04-26T10:00:00.000Z",
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
Expected: HTTP 202, `X-Trace-Id: manual-trace-001` in response headers, body `{"received":true}`.

**9. Verify idempotency — POST the same event again**
```bash
# Re-run the same curl from step 8
```
Expected: HTTP 202 again. Verify in PostgreSQL (step 10) that only ONE alarm row exists for `event_id = 'test-001'`.

**10. Verify alarm record in PostgreSQL**
```bash
docker compose exec postgres psql -U vantage -d vantage -c "SELECT id, event_id, device_id, alarm_subtype, status FROM alarms ORDER BY created_at DESC LIMIT 5;"
```
Expected: one row with `event_id: test-001`, `device_id: PM-01` (uppercase, normalised by ingestion-service), `alarm_subtype: NORM_THRESHOLD`. Re-posting the same event does not add a second row.

**11. Verify BullMQ job in Redis**
```bash
docker compose exec redis redis-cli KEYS "bull:*"
```
Expected: keys like `bull:detection-events:wait`, `bull:detection-events:meta`, etc. To inspect job data:
```bash
docker compose exec redis redis-cli LRANGE "bull:detection-events:wait" 0 -1
```
Note: if `event-store-service` were running (Phase 5), jobs would be consumed immediately and the wait list would be empty. In Phase 3 with no consumer, jobs accumulate.

**12. POST a heartbeat**
```bash
curl -si -X POST http://localhost:3001/heartbeats \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "PM-01",
    "deviceType": "PORTAL_MONITOR",
    "timestamp": "2026-04-26T10:00:00.000Z",
    "backgroundCountRate": 45,
    "status": "ONLINE"
  }'
```
Expected: HTTP 204 No Content.

**13. Verify heartbeat in Redis**
```bash
docker compose exec redis redis-cli HGETALL device:state:PM-01
```
Expected: four fields — `lastSeen` (normalised ISO8601), `backgroundCountRate`, `deviceType: PORTAL_MONITOR`, `status: ONLINE`.

```bash
docker compose exec redis redis-cli TTL device:state:PM-01
```
Expected: a number ≤ 30 (TTL counting down). Wait 31 seconds and re-run — key should be absent.

**14. POST a clear event**
```bash
curl -si -X POST http://localhost:3001/events \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "test-002",
    "deviceId": "pm-02",
    "deviceType": "PORTAL_MONITOR",
    "siteId": "POE-ALPHA",
    "timestamp": "2026-04-26T10:00:01.000Z",
    "vendorId": "VANTAGE",
    "eventType": "RADIATION_SCAN",
    "platformAlarmStatus": "CLEAR",
    "payload": {
      "type": "RADIATION_SCAN",
      "durationMs": 2000,
      "peakCountRate": 80,
      "backgroundCountRate": 45,
      "isotope": null,
      "detectorAlarmSubtype": null
    }
  }'
```
Expected: HTTP 202. No new alarm record in PostgreSQL. BullMQ job enqueued with `platformAlarmStatus: CLEAR`.

**15. Verify Prometheus metrics**
```bash
curl -s http://localhost:3001/metrics | grep ingestion_events_total
```
Expected: counter lines with labels `deviceId`, `eventType`, `platformAlarmStatus`.

---

## Decisions

**End-to-end idempotency via three independent layers:**

A network failure between alert-engine's PostgreSQL write and its HTTP response causes ingestion-service to return 503 and the client to retry. Without idempotency, that retry creates a duplicate alarm. The fix is layered across all three persistence systems:

| Layer | Mechanism | Scope |
|---|---|---|
| PostgreSQL | `event_id UNIQUE NOT NULL` + `ON CONFLICT DO NOTHING` in explicit transaction | Alarm deduplication across retries |
| BullMQ | `{ jobId: eventId }` on `queue.add` | Queue deduplication while job is in-flight |
| Elasticsearch | `eventId` as document `_id` (Phase 5) | Index deduplication on BullMQ retry replays |

Each layer handles a different failure window. The PostgreSQL layer is a retroactive change to alert-engine; the BullMQ and Elasticsearch layers are Phase 3 and Phase 5 respectively.

**`ON CONFLICT DO NOTHING` with explicit transaction (not `DO UPDATE` no-op trick):**

The alternative single-query idiom is `ON CONFLICT (event_id) DO UPDATE SET event_id = alarms.event_id RETURNING id` — a no-op update that forces `RETURNING` to fire on conflict. That is tighter (one round trip) but the intent is opaque to a reader. The two-query approach (`DO NOTHING` + conditional `SELECT`) is explicit: when the insert succeeds, use the new id; when it conflicts, fetch the existing one. The two queries are wrapped in `BEGIN`/`COMMIT` so no window exists for the row to disappear between them. `READ COMMITTED` isolation (PostgreSQL's default) is sufficient — the original insert is already committed before the retry arrives.

**`queue.add` wrapped in try/catch (indexing path is best-effort):**

If Redis is down and `queue.add` throws, the exception is caught, logged, and 202 is returned regardless. The alarm is durable in PostgreSQL; returning 500 would prompt a client retry that re-evaluates the alarm — unnecessary work with no benefit. The known gap: events that arrive during a Redis outage will be missing from Elasticsearch. In production, this requires an outbox pattern (write to a PostgreSQL outbox and BullMQ atomically via a transactional outbox or saga). For the demo, logging the failure and accepting the Elasticsearch gap is the correct default — it demonstrates awareness of the tradeoff without adding infrastructure not required by the spec.

**`{ jobId: eventId }` on `queue.add`:**

BullMQ will not enqueue a duplicate job while a job with the same ID is already in the queue. This covers the window between a successful enqueue and the event-store-service consuming the job — if a retry reaches BullMQ before the original job is processed, the second add is a no-op. BullMQ job ID deduplication is ephemeral (it only applies while the job exists in the queue); Elasticsearch `_id` deduplication covers the long-term case.

**`X-Trace-Id` in response header, not response body:**

Trace IDs belong in HTTP headers — this is the convention established by OpenTelemetry, Zipkin, and most distributed tracing systems. Returning the trace ID in the body couples API clients to a logging concern: clients must parse JSON to extract a value that is only relevant to operators. Putting it in `X-Trace-Id` makes it accessible to API gateways, load balancers, and logging middleware without touching the body. The header is set unconditionally (generated if not provided by the caller) so every response is traceable.

**`await queue.add(...)` inside try/catch (not fire-and-forget):**

`queue.add` is async — it writes a job to Redis. Using `await` inside the try/catch ensures the job is actually enqueued before returning 202. Fire-and-forget (`queue.add(...).catch(...)`) risks silently losing the job if the process exits between the response and the Redis write. The try/catch wrapper is what makes the indexing path truly best-effort: the `await` ensures the attempt completes before responding; the `catch` ensures a Redis failure does not propagate to the client.

**BullMQ over raw Redis LPUSH:** BullMQ provides job lifecycle management (retry with backoff, job state tracking, metrics) that `event-store-service` relies on in Phase 5. Using raw Redis commands would require reimplementing this. BullMQ is idiomatic for TypeScript Redis job queues and adds no new infrastructure (just a Redis list under the hood). The `detection-events` queue name must match exactly between ingestion-service (producer) and event-store-service (consumer).

**Separate ioredis instances for queue and heartbeats:** BullMQ requires `maxRetriesPerRequest: null` on its ioredis connection because it manages retry logic at the job level. A heartbeat write with `maxRetriesPerRequest: null` would silently fail after a single attempt instead of retrying. Using two ioredis instances with different options keeps each one correctly configured for its purpose.

**Module-level singletons (queue.ts, redis.ts):** Consistent with Phase 2's `pool` and `rules` pattern. Tests override via `vi.mock('bullmq')` and `vi.mock('ioredis')` — the mock constructors run when the modules are first evaluated during the test import chain. No dependency injection plumbing required in production code.

**`vi.hoisted` for BullMQ and ioredis spies:** Required by Vitest ESM hoisting semantics. `vi.mock` factories execute in the hoisted scope, before `const` declarations in the test file are initialised. `vi.hoisted(() => vi.fn())` creates the spy in the same hoisted scope, making it available when the factory references it. This is the documented Vitest pattern for spying on mock module methods.

**msw over nock:** nock intercepts Node.js's `http` module. Native `fetch` in Node 22 uses `undici` internally — nock does not intercept undici requests. msw v2 hooks into undici directly via `@mswjs/interceptors`, so it correctly intercepts `fetch` calls. This is the only safe choice for a project using native `fetch`.

**No Zod validation:** Basic presence checks are sufficient — the simulator always sends well-formed events, and this is a demo. Full schema validation adds a dependency and complexity not required by the test spec.

**`host: '0.0.0.0'`:** Same rationale as Phase 2 — required for Docker/K3s container networking.

**deviceId normalisation to uppercase:** The spec says "device IDs to uppercase". The simulator sends lowercase (`pm-01`); the alarm record in PostgreSQL stores `PM-01`. Both existing integration tests assert `enqueuedPayload.deviceId === 'PM-01'` — normalisation is a first-class tested contract.

**`ingestion_events_total` labels — `eventType` and `platformAlarmStatus` only:** Both are low-cardinality bounded sets. `deviceId` is intentionally excluded — it would create one time series per device per event type per alarm status combination, which is a standard Prometheus anti-pattern. Per-device activity is the right job for Elasticsearch (Phase 5), not Prometheus counters. The Grafana dashboard uses these counters for aggregate throughput; per-device views are served by the api-service Elasticsearch queries.

**Graceful shutdown (SIGTERM/SIGINT):** In K8s, pod termination begins with SIGTERM. Without a handler, the process exits immediately and any in-flight `queue.add()` awaits are dropped mid-flight. The shutdown sequence (`app.close()` → `queue.close()` → `connection.quit()` → `redis.quit()`) drains in-flight requests, finalises BullMQ state, and cleanly closes both ioredis connections. Signal handlers are registered after `app.listen()` so they can close the live app instance.
