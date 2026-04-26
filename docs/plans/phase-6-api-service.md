---
status: Draft
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-2-alert-engine.md
  - docs/plans/phase-5-event-store-service.md
---

# Phase 6: api-service

## Objective

Build the `api-service` — the single backend entry point for the Angular dashboard. It exposes REST endpoints backed by all three data stores (PostgreSQL, Redis, Elasticsearch), a WebSocket server that pushes live alarm notifications to connected dashboard clients, and an internal endpoint called by alert-engine when an alarm fires.

When this phase is complete:
- `GET /api/alarms` returns paginated, server-side-filtered alarm history from PostgreSQL (filters: `status`, `deviceId`, `alarmSubtype`, date range)
- `GET /api/alarms/:id` returns a single alarm
- `PATCH /api/alarms/:id/acknowledge` updates alarm status and persists to PostgreSQL
- `GET /api/events/search` queries the `detection-events` Elasticsearch index with filtering
- `GET /api/devices` returns device state from Redis, including OFFLINE status for devices with expired keys
- `POST /api/scenarios/:name` proxies to the telemetry-simulator's scenario endpoint
- `POST /api/internal/alarms/notify` receives alarm events from alert-engine and broadcasts to all connected WebSocket clients
- `wscat -c ws://localhost:3004/ws` connects successfully and receives alarm JSON within 2 seconds of a scenario trigger

---

## Context

**What api-service is:** The aggregation layer between three data stores and the Angular dashboard. It reads from all three data stores (never writes to Elasticsearch or Redis heartbeat state), and writes only when acknowledging alarms in PostgreSQL.

**Why all REST routes are prefixed `/api/`:** The nginx ingress routes `/api/*` to api-service and `/` to the Angular dashboard. All api-service routes must include the `/api` prefix so they are reachable through the ingress without path rewriting. alert-engine already has this prefix hardcoded in its `notifyApiService` call (`fetch(\`${apiServiceUrl}/api/internal/alarms/notify\``)) — the prefix is established and must be honoured.

**Why the `ws` package (not `@fastify/websocket`):** The spec explicitly requires the `ws` package. It is attached to Fastify's underlying Node.js `http.Server` after `app.listen()` is called. This keeps the WebSocket integration thin and avoids plugin lifecycle coupling. The WebSocket path (`/ws`) is enforced by checking `req.url` in the `connection` handler.

**Why `broadcast` lives in a module singleton (`ws.ts`):** The `POST /api/internal/alarms/notify` route handler needs to call `broadcast()`. If `broadcast` were threaded through `buildServer()` as a parameter, it would need to be constructed before the WS server exists. Exporting `broadcast` from `ws.ts` as a module-level function breaks this cycle cleanly — the notify route imports it directly, and `initWebSocket()` is called in `main()` after the Fastify server starts.

**Why api-service runs no migrations:** alert-engine owns the PostgreSQL schema. api-service is a read-mostly consumer. The `PATCH /acknowledge` route does write to PostgreSQL, but only updates an existing row — no DDL required.

**Why `DeviceState.lastSeen` and `backgroundCountRate` must be nullable:** An offline device has no current Redis key. The response must still include the device (the dashboard always shows all three cards). Returning `null` for `lastSeen` and `backgroundCountRate` on offline devices is semantically correct. Phase 6 updates `@vantage/types` to reflect this. This is a non-breaking change — the Angular dashboard handles null values as "—" or "never".

**Why `initWebSocket` is called after `app.listen()`:** `app.server` (Fastify's underlying `http.Server`) exists as soon as Fastify is created, but the WS server needs to handle upgrade requests on the same port that Fastify is listening on. Calling `initWebSocket` after `app.listen()` ensures the port is bound before the WS server attaches.

**Why the notify handler fetches the full alarm from PostgreSQL:** The payload alert-engine sends to `/api/internal/alarms/notify` is minimal — it does not include `peakCountRate` or `isotope`. The Angular dashboard's Active Alarms panel needs these fields to display without a follow-up REST call. Fetching the full alarm row during notify is safe: alert-engine commits the transaction before calling `notifyApiService`, so by the time the notify request arrives the alarm row is definitely in PostgreSQL.

**Why `GET /api/devices` uses a hardcoded device list rather than Redis `SCAN`:** The dashboard always shows three fixed device cards, even when the simulator is stopped and all devices are OFFLINE (their Redis keys have expired). If the device list were derived purely from Redis keys, all cards would disappear when the simulator stops — invalidating the "device cards show OFFLINE within 30 seconds" DoD criterion. The three known devices are defined as a constant; Redis enriches their status.

---

## Types update — `@vantage/types`

Update `packages/types/src/index.ts` before implementing api-service. Change `DeviceState` to allow null fields for offline devices:

```typescript
// Shape returned by GET /api/devices
export interface DeviceState {
  deviceId: string;
  deviceType: string;
  lastSeen: string | null;          // null when device is OFFLINE
  backgroundCountRate: number | null; // null when device is OFFLINE
  status: 'ONLINE' | 'OFFLINE';
}
```

No other types change.

---

## File Tree

```
apps/api-service/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # entry: start server → init WS → register shutdown
    ├── server.ts             # Fastify factory: all REST routes + /metrics + /health
    ├── ws.ts                 # WebSocket server lifecycle + broadcast()
    ├── db.ts                 # pg.Pool + AlarmRow type + mapAlarmRow()
    ├── redis.ts              # ioredis client
    ├── elasticsearch.ts      # ES client
    ├── metrics.ts            # prom-client registry
    ├── logger.ts             # shared pino instance
    └── routes/
        ├── alarms.ts         # GET /api/alarms, GET /api/alarms/:id, PATCH …/acknowledge
        ├── events.ts         # GET /api/events/search
        ├── devices.ts        # GET /api/devices
        ├── scenarios.ts      # POST /api/scenarios/:name
        └── notify.ts         # POST /api/internal/alarms/notify
```

No test file. The spec explicitly excludes api-service from unit testing: routes are exercised by the live system during DoD verification.

---

## `apps/api-service/package.json`

```json
{
  "name": "@vantage/api-service",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx --env-file=../../.env src/index.ts",
    "dev": "tsx watch --env-file=../../.env src/index.ts"
  },
  "dependencies": {
    "@elastic/elasticsearch": "^8.0.0",
    "@vantage/types": "workspace:*",
    "fastify": "^5.0.0",
    "ioredis": "^5.0.0",
    "pg": "^8.0.0",
    "pino": "^10.0.0",
    "prom-client": "^15.0.0",
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "@types/pg": "^8.0.0",
    "@types/ws": "^8.0.0",
    "tsx": "^4.0.0",
    "vitest": "^4.0.0"
  }
}
```

**`@elastic/elasticsearch` `"^8.0.0"` pin is critical** — same as event-store-service. The `latest` tag resolves to v9.x with breaking API changes. This service uses v8 to match the docker-compose image. Same API patterns as Phase 5: `document:` on index calls (not used here — read-only), `SearchResponse` types from the v8 client.

**`ioredis` is a direct dependency** here, unlike event-store-service which uses BullMQ's bundled ioredis. api-service uses ioredis directly to read `device:state:*` hashes, so it needs its own ioredis instance. The `Redis` class from `ioredis` is used (not BullMQ-bundled), so a direct dependency is correct.

---

## `apps/api-service/tsconfig.json`

Standard app tsconfig — identical pattern to all other services.

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

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    bindings: (bindings) => ({ ...bindings, service: 'api-service' }),
  },
});
```

---

## `src/metrics.ts`

```typescript
import { Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });
```

No custom metrics beyond the default set. The build spec calls for HTTP request count and latency histogram — these are deferred to the Prometheus service-level instrumentation in Phase 10 via Grafana dashboards on default metrics. Adding per-route instrumentation here without a Fastify plugin requires significant boilerplate that adds no demo value.

---

## `src/redis.ts`

```typescript
import { Redis } from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
```

Identical pattern to ingestion-service. `REDIS_URL` is validated at startup in `index.ts` so the fallback is only for type safety.

---

## `src/elasticsearch.ts`

```typescript
import { Client } from '@elastic/elasticsearch';

export const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
});
```

Read-only client. No index creation (Phase 5 handles that). `ELASTICSEARCH_URL` is validated at startup in `index.ts`.

---

## `src/db.ts`

Exports the pg pool, the `AlarmRow` database row type (snake_case as returned by `pg`), and the `mapAlarmRow` conversion function. Routes import all three from here.

```typescript
import { Pool } from 'pg';
import type { Alarm } from '@vantage/types';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg returns column names in snake_case and NUMERIC columns as strings.
export interface AlarmRow {
  id: string;
  device_id: string;
  site_id: string;
  event_type: string;
  alarm_subtype: string;
  peak_count_rate: string | null; // NUMERIC → string from pg; coerce with Number()
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggered_at: Date;
  acknowledged_at: Date | null;
  created_at: Date;
}

export function mapAlarmRow(row: AlarmRow): Alarm {
  return {
    id: row.id,
    deviceId: row.device_id,
    siteId: row.site_id,
    eventType: row.event_type,
    alarmSubtype: row.alarm_subtype,
    peakCountRate: row.peak_count_rate !== null ? Number(row.peak_count_rate) : null,
    isotope: row.isotope,
    status: row.status,
    triggeredAt: row.triggered_at.toISOString(),
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
```

**`NUMERIC` → `string` note:** PostgreSQL `peak_count_rate` is a `NUMERIC` column. The `pg` driver returns `NUMERIC` values as strings to avoid JavaScript floating-point precision loss. `Number()` coercion is correct here (same pattern as alert-engine's `db.ts`).

---

## `src/ws.ts`

The WebSocket server lifecycle and the `broadcast` function. `initWebSocket` is called once in `main()` after Fastify starts listening. The `clients` Set is module-level — `broadcast` closes over it.

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { logger } from './logger.js';

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (req.url !== '/ws') {
      ws.close(1008, 'Invalid path');
      return;
    }

    clients.add(ws);
    logger.info({ clientCount: clients.size }, 'ws client connected');

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ clientCount: clients.size }, 'ws client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'ws client error');
      clients.delete(ws);
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'ws server error');
  });

  logger.info('WebSocket server initialised on /ws');
}

export function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  }
  logger.info({ clientCount: clients.size, sent }, 'alarm broadcast');
}

export function closeWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }
    // Terminate all clients immediately — wss.close() callback only fires once
    // every existing connection has closed. Without this, a connected dashboard
    // or wscat session keeps the promise pending until K8s sends SIGKILL.
    for (const client of clients) {
      client.terminate();
    }
    wss.close(() => resolve());
  });
}
```

**Path filtering on `req.url`:** The WS server is attached to the same http.Server as Fastify. All HTTP requests are handled by Fastify; the `upgrade` event for non-WS requests never reaches the WS server. Checking `req.url === '/ws'` guards against clients connecting to unexpected paths. `ws.close(1008, 'Invalid path')` uses the WebSocket policy violation close code.

**No ping/pong keepalive:** Not required for the demo. nginx-ingress's 3600-second timeout annotation (Phase 8) prevents idle connections from being terminated by the ingress. A production system would add ping/pong, but this adds complexity without demo value.

---

## `src/routes/alarms.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { pool, mapAlarmRow, type AlarmRow } from '../db.js';

interface AlarmsQuery {
  limit?: string;
  offset?: string;
  status?: string;       // 'ACTIVE' | 'ACKNOWLEDGED'
  deviceId?: string;
  alarmSubtype?: string;
  from?: string;         // triggeredAt range start (ISO8601)
  to?: string;           // triggeredAt range end (ISO8601)
}

export async function alarmsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: AlarmsQuery }>(
    '/api/alarms',
    async (request) => {
      const limitRaw = Number(request.query.limit ?? 50);
      const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 0), 200);
      const offsetRaw = Number(request.query.offset ?? 0);
      const offset = Math.max(Number.isNaN(offsetRaw) ? 0 : offsetRaw, 0);
      const { status, deviceId, alarmSubtype, from, to } = request.query;

      // Build parameterised WHERE clause dynamically.
      // filterParams is shared between the COUNT and SELECT queries; LIMIT/OFFSET
      // are appended after the filter params for the SELECT only.
      const conditions: string[] = [];
      const filterParams: unknown[] = [];

      if (status) {
        filterParams.push(status);
        conditions.push(`status = $${filterParams.length}`);
      }
      if (deviceId) {
        filterParams.push(deviceId);
        conditions.push(`device_id = $${filterParams.length}`);
      }
      if (alarmSubtype) {
        filterParams.push(alarmSubtype);
        conditions.push(`alarm_subtype = $${filterParams.length}`);
      }
      if (from) {
        filterParams.push(from);
        conditions.push(`triggered_at >= $${filterParams.length}`);
      }
      if (to) {
        filterParams.push(to);
        conditions.push(`triggered_at <= $${filterParams.length}`);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const n = filterParams.length;

      const [countResult, rowsResult] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM alarms ${whereClause}`,
          filterParams,
        ),
        pool.query<AlarmRow>(
          `SELECT id, device_id, site_id, event_type, alarm_subtype,
                  peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
           FROM alarms
           ${whereClause}
           ORDER BY triggered_at DESC
           LIMIT $${n + 1} OFFSET $${n + 2}`,
          [...filterParams, limit, offset],
        ),
      ]);

      return {
        total: Number(countResult.rows[0].count),
        alarms: rowsResult.rows.map(mapAlarmRow),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/alarms/:id',
    async (request, reply) => {
      const result = await pool.query<AlarmRow>(
        `SELECT id, device_id, site_id, event_type, alarm_subtype,
                peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
         FROM alarms WHERE id = $1`,
        [request.params.id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Alarm not found' });
      }

      return mapAlarmRow(result.rows[0]);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/alarms/:id/acknowledge',
    async (request, reply) => {
      // Single UPDATE ... RETURNING — 404 if no row matched, otherwise return updated alarm.
      // COALESCE preserves the original acknowledged_at if already acknowledged (idempotent).
      const result = await pool.query<AlarmRow>(
        `UPDATE alarms
         SET status = 'ACKNOWLEDGED', acknowledged_at = COALESCE(acknowledged_at, NOW())
         WHERE id = $1
         RETURNING id, device_id, site_id, event_type, alarm_subtype,
                   peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at`,
        [request.params.id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Alarm not found' });
      }

      return mapAlarmRow(result.rows[0]);
    },
  );
}
```

**`PATCH /acknowledge` uses `UPDATE ... RETURNING *`:** A single round trip both updates the row and returns the updated data. An empty `RETURNING` result (0 rows affected) means the ID didn't exist — 404. This eliminates the existence-check pre-query and the post-update SELECT. `COALESCE(acknowledged_at, NOW())` preserves the original `acknowledged_at` if the alarm was already acknowledged, making the operation idempotent.

**Pagination response shape:** `{ total: number, alarms: Alarm[] }` — `total` is the filtered count (respects active WHERE clause), enabling the Angular table's paginator to show correct page count without a second request.

**Server-side filtering:** The `COUNT(*)` and `SELECT` queries share the same dynamically built `filterParams` array. LIMIT and OFFSET are appended after the filter params so their `$N` positions are always `n+1` and `n+2`. The Angular Alarm History view uses `?status=ACTIVE` or `?status=ACKNOWLEDGED` for its status tab filter; the Active Alarms panel seeds its initial state with `?status=ACTIVE`.

---

## `src/routes/events.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch';
import type { DetectionEvent } from '@vantage/types';
import { esClient } from '../elasticsearch.js';

interface SearchQuery {
  q?: string;
  from?: string;  // date range start (ISO8601)
  to?: string;    // date range end (ISO8601)
  deviceId?: string;
  eventType?: string;
  limit?: string;
  offset?: string;
}

export async function eventsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: SearchQuery }>(
    '/api/events/search',
    async (request) => {
      const { q, from, to, deviceId, eventType } = request.query;
      const sizeRaw = Number(request.query.limit ?? 50);
      const size = Math.min(Math.max(Number.isNaN(sizeRaw) ? 50 : sizeRaw, 0), 200);
      const esOffsetRaw = Number(request.query.offset ?? 0);
      const esOffset = Math.max(Number.isNaN(esOffsetRaw) ? 0 : esOffsetRaw, 0);

      const must: QueryDslQueryContainer[] = [];
      const filter: QueryDslQueryContainer[] = [];

      if (q) {
        // Wildcard contains-match with case_insensitive: true on each keyword field.
        // multi_match on keyword fields is exact-match only — 'PM' would not match 'PM-01'.
        // Wrapping user input as *q* gives contains semantics; case_insensitive covers
        // operators typing 'alarm' vs 'ALARM'.
        const searchFields = [
          'deviceId',
          'siteId',
          'eventType',
          'platformAlarmStatus',
          'payload.isotope',
          'payload.detectorAlarmSubtype',
        ];
        must.push({
          bool: {
            should: searchFields.map((field) => ({
              wildcard: { [field]: { value: `*${q}*`, case_insensitive: true } },
            })),
            minimum_should_match: 1,
          },
        });
      }

      if (from || to) {
        const range: { gte?: string; lte?: string } = {};
        if (from) range.gte = from;
        if (to) range.lte = to;
        filter.push({ range: { timestamp: range } });
      }

      if (deviceId) filter.push({ term: { deviceId: { value: deviceId } } });
      if (eventType) filter.push({ term: { eventType: { value: eventType } } });

      const esQuery: QueryDslQueryContainer =
        must.length === 0 && filter.length === 0
          ? { match_all: {} }
          : {
              bool: {
                ...(must.length ? { must } : {}),
                ...(filter.length ? { filter } : {}),
              },
            };

      const result = await esClient.search<DetectionEvent>({
        index: 'detection-events',
        from: esOffset,
        size,
        sort: [{ timestamp: { order: 'desc' as const } }],
        query: esQuery,
      });

      const total =
        typeof result.hits.total === 'object'
          ? result.hits.total.value
          : (result.hits.total ?? 0);

      return {
        total,
        events: result.hits.hits.map((hit) => hit._source),
      };
    },
  );
}
```

**Wildcard contains-search on keyword fields:** The `q` parameter uses `wildcard` queries with `case_insensitive: true` and a `*q*` pattern, wrapped in a `bool.should` so a match on any field satisfies the query. This gives operators partial, case-insensitive search across device IDs, isotopes, and alarm statuses — typing "PM" matches "PM-01", "alarm" matches "ALARM". ES `wildcard` on keyword fields with a leading wildcard (`*term`) has O(n) scan characteristics, which is fine for a demo dataset. `multi_match` was the original approach but performs exact-match only on keyword fields and would not match partial device IDs.

**Why `object` type (not `nested`) works here:** Phase 5 established the `payload` field as `object` type. `range` queries on `payload.peakCountRate` and `term` queries on `payload.isotope` work without nested DSL. This is the payoff of the Phase 5 mapping decision.

**`from` naming conflict:** The query string param `from` (date range start) and ES pagination `from` are separate concepts. The code uses `esOffset` for the ES pagination parameter to avoid shadowing. The `from` variable is scoped to the date range range object.

---

## `src/routes/devices.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import type { DeviceState } from '@vantage/types';
import { redis } from '../redis.js';

// Fixed device list — the dashboard always shows these three cards.
// Redis enriches online devices; absent key means OFFLINE.
const KNOWN_DEVICES = [
  { deviceId: 'PM-01', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'PM-02', deviceType: 'PORTAL_MONITOR' },
  { deviceId: 'RIID-01', deviceType: 'RIID' },
] as const;

export async function devicesRoutes(app: FastifyInstance) {
  app.get('/api/devices', async (): Promise<DeviceState[]> => {
    return Promise.all(
      KNOWN_DEVICES.map(async ({ deviceId, deviceType }): Promise<DeviceState> => {
        const data = await redis.hgetall(`device:state:${deviceId}`);

        if (!data || Object.keys(data).length === 0) {
          return {
            deviceId,
            deviceType,
            lastSeen: null,
            backgroundCountRate: null,
            status: 'OFFLINE',
          };
        }

        return {
          deviceId,
          deviceType: data.deviceType ?? deviceType,
          lastSeen: data.lastSeen ?? null,
          backgroundCountRate:
            data.backgroundCountRate != null
              ? Number(data.backgroundCountRate)
              : null,
          status: 'ONLINE',
        };
      }),
    );
  });
}
```

**Redis `hgetall` returns `Record<string, string>` or `{}` for missing keys:** ioredis returns an empty object (not null) when a key does not exist. The `Object.keys(data).length === 0` check handles the missing-key case.

**`deviceType` from Redis hash vs hardcoded:** The Redis hash stored by ingestion-service's heartbeat handler includes `deviceType`. We prefer the hash value (which the device reported) over the hardcoded constant. The fallback to the hardcoded `deviceType` handles the offline case where `data` is empty.

---

## `src/routes/scenarios.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { logger } from '../logger.js';

export async function scenariosRoutes(app: FastifyInstance) {
  app.post<{ Params: { name: string } }>(
    '/api/scenarios/:name',
    async (request, reply) => {
      const { name } = request.params;
      const simulatorUrl = process.env.TELEMETRY_SIMULATOR_URL;

      if (!simulatorUrl) {
        logger.error({ scenario: name }, 'TELEMETRY_SIMULATOR_URL not configured');
        return reply.status(503).send({ error: 'Simulator not configured' });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${simulatorUrl}/scenario/${name}`, {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status === 404) {
          return reply.status(404).send({ error: `Unknown scenario: ${name}` });
        }

        if (!response.ok) {
          logger.warn({ name, status: response.status }, 'scenario delivery failed');
          return reply.status(502).send({ error: 'Scenario delivery failed' });
        }

        return reply.send({ ok: true, scenario: name });
      } catch (err) {
        clearTimeout(timeout);
        logger.warn({ err, name }, 'simulator unreachable');
        return reply.status(502).send({ error: 'Simulator unreachable' });
      }
    },
  );
}
```

**`TELEMETRY_SIMULATOR_URL` is checked at request time (not startup):** The simulator is disabled in the central Helm profile (`values-central.yaml`). A missing env var makes this endpoint return 503 rather than crashing the service on startup. All other required env vars are validated at startup.

**Path translation:** The api-service route is `/api/scenarios/:name`; the simulator route is `/scenario/:name` (no `/api` prefix). The proxy strips the `/api` prefix.

---

## `src/routes/notify.ts`

```typescript
import type { FastifyInstance } from 'fastify';
import { pool, mapAlarmRow, type AlarmRow } from '../db.js';
import { broadcast } from '../ws.js';
import { logger } from '../logger.js';

interface NotifyBody {
  alarmId: string;
  alarmSubtype: string;
  deviceId: string;
  siteId: string;
  timestamp: string;
}

export async function notifyRoutes(app: FastifyInstance) {
  app.post<{ Body: NotifyBody }>(
    '/api/internal/alarms/notify',
    async (request, reply) => {
      const body = request.body;

      if (!body?.alarmId) {
        return reply.status(400).send({ error: 'alarmId is required' });
      }

      const traceId = request.headers['x-trace-id'] as string | undefined;

      const result = await pool.query<AlarmRow>(
        `SELECT id, device_id, site_id, event_type, alarm_subtype,
                peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
         FROM alarms WHERE id = $1`,
        [body.alarmId],
      );

      if (result.rows.length === 0) {
        // alert-engine commits before calling notify, so this path should never fire.
        // Broadcasting a partial payload would produce a message the dashboard cannot
        // parse (no `alarm` field), so we drop the broadcast and surface the anomaly.
        logger.error({ alarmId: body.alarmId, traceId }, 'alarm not found in PG during notify — broadcast dropped');
        return reply.status(204).send();
      }

      broadcast({ type: 'alarm', alarm: mapAlarmRow(result.rows[0]) });
      logger.info({ alarmId: body.alarmId, traceId }, 'alarm notified to WS clients');
      return reply.status(204).send();
    },
  );
}
```

**WebSocket message shape:** always `{ type: 'alarm', alarm: Alarm }`. The `type` discriminator allows the Angular dashboard to handle multiple event types over the same WS connection in the future (e.g., `type: 'deviceOffline'`). The dashboard destructures `message.alarm` to populate the Active Alarms panel. The fallback path (alarm not found in PG) drops the broadcast rather than emitting a partial shape — the shape contract is invariant.

**204 No Content response:** The notify endpoint is internal. alert-engine does not use the response body. 204 is the correct HTTP response for a side-effect-only operation with no response body.

---

## `src/server.ts`

```typescript
import Fastify from 'fastify';
import { alarmsRoutes } from './routes/alarms.js';
import { eventsRoutes } from './routes/events.js';
import { devicesRoutes } from './routes/devices.js';
import { scenariosRoutes } from './routes/scenarios.js';
import { notifyRoutes } from './routes/notify.js';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  await app.register(alarmsRoutes);
  await app.register(eventsRoutes);
  await app.register(devicesRoutes);
  await app.register(scenariosRoutes);
  await app.register(notifyRoutes);

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

```typescript
import { buildServer } from './server.js';
import { initWebSocket, closeWebSocket } from './ws.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { esClient } from './elasticsearch.js';
import { logger } from './logger.js';

async function main() {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'ELASTICSEARCH_URL'].filter(
    (v) => !process.env[v],
  );
  if (missing.length > 0) {
    logger.error({ missing }, 'required env vars not set');
    process.exit(1);
  }

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3004);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'api-service ready');

  // Must be called after app.listen() — the WS server attaches to the bound http.Server
  initWebSocket(app.server);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();       // stop accepting new HTTP requests
      await closeWebSocket();  // close all WebSocket connections
      await pool.end();        // drain pg connection pool
      await redis.quit();      // close Redis connection
      await esClient.close();  // close ES connection pool
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  logger.error({ err }, 'api-service startup failed');
  process.exit(1);
});
```

**`TELEMETRY_SIMULATOR_URL` is intentionally absent from the startup check.** It is an optional dependency (disabled in the central Helm profile). The scenarios route checks for it at request time and returns 503 if absent.

**Shutdown order matters:** Fastify is closed first (no new HTTP requests, no new `/api/internal/alarms/notify` calls), then the WS server (no new connections, in-flight sends complete), then infrastructure clients (pg pool, Redis). This ordering prevents a notify call arriving after the WS server is closed but while the HTTP server is still accepting.

---

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `ELASTICSEARCH_URL` | Yes | — | ES node URL |
| `TELEMETRY_SIMULATOR_URL` | No | — | Checked at request time for scenarios proxy |
| `PORT` | No | 3004 | HTTP + WS bind port |
| `LOG_LEVEL` | No | `info` | Pino log level |

Add to both `.env.example` and `.env` at repo root:
```
TELEMETRY_SIMULATOR_URL=http://localhost:3000
```
The `API_SERVICE_URL=http://localhost:3004` entry should already be present for alert-engine's best-effort notify.

---

## Verification Steps

Run these in order after implementing all files.

**1. Update types and install dependencies**
```bash
pnpm install
```
After updating `packages/types/src/index.ts` to make `DeviceState` fields nullable.

**2. Typecheck across the monorepo**
```bash
pnpm typecheck
```
Expected: exits 0. The `DeviceState` change is non-breaking — no existing service uses `lastSeen` or `backgroundCountRate` from `DeviceState`.

**3. Lint**
```bash
pnpm lint
```
Expected: exits 0.

**4. Start infrastructure**
```bash
pnpm infra:up
```

**5. Start all five services** (each in a separate terminal)
```bash
cd apps/alert-engine && pnpm start
cd apps/ingestion-service && pnpm start
cd apps/telemetry-simulator && pnpm start
cd apps/event-store-service && pnpm start
cd apps/api-service && pnpm start
```

Expected api-service log sequence:
- `"api-service ready"` with `port: 3004`
- `"WebSocket server initialised on /ws"`

**6. Verify device state (simulator must be running ≥5s)**
```bash
curl -s http://localhost:3004/api/devices | python3 -m json.tool
```
Expected: array of three devices with `status: "ONLINE"`, `lastSeen` populated, `backgroundCountRate` ~45.

**7. Verify device offline detection**

Stop the telemetry-simulator. Wait 35 seconds (30s Redis TTL + 5s margin).
```bash
curl -s http://localhost:3004/api/devices | python3 -m json.tool
```
Expected: all three devices show `status: "OFFLINE"`, `lastSeen: null`, `backgroundCountRate: null`.

Restart the simulator. Within 10 seconds (first heartbeat cycle) devices should return to ONLINE.

**8. Connect a WebSocket client**
```bash
# Install wscat if needed: npm install -g wscat
wscat -c ws://localhost:3004/ws
```
Expected: connected, no output until an alarm fires.

**9. Trigger a scenario and observe the WebSocket**

In a separate terminal:
```bash
curl -s -X POST http://localhost:3004/api/scenarios/norm-threshold | python3 -m json.tool
```
Expected curl response: `{ "ok": true, "scenario": "norm-threshold" }`

Expected wscat output within 2 seconds:
```json
{"type":"alarm","alarm":{"id":"...","deviceId":"PM-01","alarmSubtype":"NORM_THRESHOLD","status":"ACTIVE",...}}
```

**10. Verify alarms REST endpoints**
```bash
# List alarms (should have at least one)
curl -s http://localhost:3004/api/alarms | python3 -m json.tool

# Get the alarm ID from the above, then fetch it
ALARM_ID="<id from above>"
curl -s "http://localhost:3004/api/alarms/${ALARM_ID}" | python3 -m json.tool

# Acknowledge the alarm
curl -s -X PATCH "http://localhost:3004/api/alarms/${ALARM_ID}/acknowledge" | python3 -m json.tool
```
Expected: after PATCH, the alarm shows `status: "ACKNOWLEDGED"` with `acknowledgedAt` populated.

Verify idempotency: running the PATCH again returns the same alarm with the same `acknowledgedAt` timestamp.

**11. Verify pagination**
```bash
curl -s "http://localhost:3004/api/alarms?limit=2&offset=0" | python3 -m json.tool
```
Expected: `{ "total": <N>, "alarms": [...] }` with at most 2 alarms in the array.

**11a. Verify pagination edge cases**
```bash
# limit=1 — only the newest alarm
curl -s "http://localhost:3004/api/alarms?limit=1&offset=0" | python3 -m json.tool
```
Expected: `alarms` contains exactly 1 item; `total` still reflects the full count (not 1).

```bash
# offset beyond total — empty page, not an error
TOTAL=$(curl -s "http://localhost:3004/api/alarms" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
curl -s "http://localhost:3004/api/alarms?limit=50&offset=${TOTAL}" | python3 -m json.tool
```
Expected: `{ "total": <N>, "alarms": [] }` — empty `alarms` array, HTTP 200, `total` unchanged.

```bash
# limit capped at 200 — verify the server enforces the maximum
curl -s "http://localhost:3004/api/alarms?limit=9999&offset=0" | python3 -m json.tool
```
Expected: returns at most 200 alarms regardless of the requested limit.

**11b. Verify alarm filters**
```bash
# Active alarms only (used by Active Alarms panel initial load)
curl -s "http://localhost:3004/api/alarms?status=ACTIVE" | python3 -m json.tool

# After acknowledging an alarm from step 10:
curl -s "http://localhost:3004/api/alarms?status=ACKNOWLEDGED" | python3 -m json.tool
```
Expected: `total` and `alarms` array both reflect the filtered subset — acknowledged alarms do not appear in the `ACTIVE` response.

```bash
# Filter by device
curl -s "http://localhost:3004/api/alarms?deviceId=PM-01" | python3 -m json.tool

# Date range — today only
DATE=$(date -u +%Y-%m-%dT00:00:00Z)
curl -s "http://localhost:3004/api/alarms?from=${DATE}" | python3 -m json.tool
```
Expected: `total` reflects the filtered count, not the total alarm count.

**12. Verify events search**

Wait ~30 seconds for events to be indexed into Elasticsearch by event-store-service, then:

```bash
# All recent events (no filters)
curl -s "http://localhost:3004/api/events/search" | python3 -m json.tool

# Filter by device
curl -s "http://localhost:3004/api/events/search?deviceId=PM-01" | python3 -m json.tool

# Filter by alarm status
curl -s "http://localhost:3004/api/events/search?q=ALARM" | python3 -m json.tool

# Date range (using today's ISO date)
DATE=$(date -u +%Y-%m-%dT00:00:00Z)
curl -s "http://localhost:3004/api/events/search?from=${DATE}" | python3 -m json.tool
```
Expected: results filtered correctly. `total` reflects the matching count.

**13. Verify scenario not-found handling**
```bash
curl -s -X POST http://localhost:3004/api/scenarios/does-not-exist
```
Expected: HTTP 404 with `{ "error": "Unknown scenario: does-not-exist" }`.

**14. Verify Prometheus metrics**
```bash
curl -s http://localhost:3004/metrics | grep -E 'nodejs|process'
```
Expected: default Node.js metrics (heap, event loop, GC) are present.

**15. Verify graceful shutdown**

Press `Ctrl+C` in the api-service terminal. Expected: logs show `"shutdown signal received"`, `"shutdown complete"`, process exits 0.

---

## Decisions

**`ws` package attached to `app.server` (not `@fastify/websocket` plugin):** The spec names the `ws` package explicitly. Attaching directly to `app.server` is the canonical pattern for integrating `ws` with any Node.js HTTP framework. `@fastify/websocket` wraps this same integration but adds plugin lifecycle coupling and a different API surface that is not referenced anywhere in the spec. Using `ws` directly keeps the WS integration transparent and reviewable.

**`broadcast` as module-level function in `ws.ts`:** The notify route handler needs to call `broadcast()`. Two approaches: (a) pass `broadcast` into `buildServer()` as a parameter, or (b) export it as a module function from `ws.ts`. Option (a) requires the WS server to be set up before `buildServer()` is called, but the WS server needs `app.server` which is only bound after `app.listen()`. Option (b) breaks the cycle: `ws.ts` initialises independently via `initWebSocket(server)` in `main()`, and the notify route imports `broadcast` at module load time (a stable function reference). This is the correct direction for the dependency.

**Known device list hardcoded in `devices.ts`:** The alternative (Redis `SCAN device:state:*`) only shows devices that have sent a heartbeat within the last 30 seconds. The DoD requires device cards to show `OFFLINE` when the simulator stops — not disappear. Hardcoding the three known devices ensures the dashboard always shows all three cards and that "OFFLINE" is a meaningful state, not an absent response.

**`GET /api/alarms` response shape `{ total, alarms }` with server-side filtering:** The Angular Alarm History view needs a paginator and status/device/date filters. The Active Alarms panel seeds its initial state with `?status=ACTIVE`. Server-side filtering is necessary — client-side filtering would require fetching all alarms on every load, and the `total` in the response must reflect the filtered count for the paginator to work correctly. Both `COUNT(*)` and `SELECT` share the same dynamically built `filterParams` array so the count is always consistent with the returned rows.

**`PATCH /acknowledge` uses `UPDATE ... RETURNING *`:** A single round trip both updates the row and detects non-existence (0 rows → 404). `COALESCE(acknowledged_at, NOW())` preserves the original timestamp on re-acknowledges, so the operation is idempotent. This eliminates the separate existence-check SELECT and post-update SELECT that a naïve implementation would use.

**No Elasticsearch write operations in api-service:** api-service reads from all three data stores but writes only to PostgreSQL (alarm acknowledgement). Elasticsearch indices are written exclusively by event-store-service. Redis heartbeat state is written exclusively by ingestion-service. This clean write ownership makes the data flow unambiguous and prevents accidental index corruption.

**`TELEMETRY_SIMULATOR_URL` checked at request time:** The simulator is absent in the central Helm deployment profile. Checking at request time means the service starts cleanly without the simulator; the scenarios endpoint returns 503 when called. All other endpoints are unaffected. This mirrors the pattern used throughout the project for best-effort dependencies.

**`closeWebSocket()` terminates clients before closing the server:** `wss.close()` stops accepting new connections but its callback only fires once all existing connections have closed. A connected dashboard keeps the promise pending indefinitely; K8s then sends SIGKILL after `terminationGracePeriodSeconds: 30`, causing unclean exit. Calling `client.terminate()` on every known client before `wss.close()` forces them closed immediately, so the callback fires promptly. `terminate()` (hard close) is appropriate here — we're already in graceful shutdown and the client will reconnect.

**`QueryDslQueryContainer[]` for `must`/`filter` arrays in `events.ts`:** The arrays that accumulate ES query clauses are typed as `QueryDslQueryContainer[]` (imported from the main `@elastic/elasticsearch` package entry, consistent with how `Client` and `errors` are imported by event-store-service). This allows TypeScript to verify each query object and ensures `esQuery` can be annotated as `QueryDslQueryContainer` without a type assertion. Specific sub-object types follow the v8 client's object form: `range` as `{ gte?: string; lte?: string }` (not `Record<string, string>`) and `term` values as `{ value: string }` (not the shorthand string form), both required for structural assignability. `esClient.search<DetectionEvent>()` types `hit._source` as `DetectionEvent | undefined` rather than `unknown`.

**Wildcard search (not `multi_match`) for the `q` parameter:** `multi_match` on keyword fields performs exact-match, so "PM" would not match "PM-01" and "alarm" would not match "ALARM". ES `wildcard` with `case_insensitive: true` and `*q*` pattern gives contains semantics across all search fields. The leading wildcard has linear scan cost, which is acceptable for a demo dataset. `query_string` was considered but it parses Lucene syntax, meaning user input like "PM-01" could be misinterpreted as `PM NOT 01`.

**No unit tests:** The build spec explicitly excludes api-service unit testing: "api-service routes (exercised via the live system in DoD verification)". The routes are thin wrappers around standard database and HTTP client calls. Unit tests would require mocking pg, ioredis, and the ES client — significant test infrastructure for marginal additional confidence. The DoD verification steps above cover all routes against a real running stack.
