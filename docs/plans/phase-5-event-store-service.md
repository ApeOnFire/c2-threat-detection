---
status: Ready for Implementation
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-1-foundation.md
  - docs/plans/phase-2-alert-engine.md
---

# Phase 5: event-store-service

## Objective

Build the `event-store-service` — a BullMQ worker that consumes the `detection-events` queue and indexes each `DetectionEvent` into Elasticsearch. The service creates the `detection-events` index with an explicit field mapping on startup, then runs the worker loop and a minimal HTTP server exposing `/metrics` and `/health`.

This service has no inbound traffic from other services. It is a pure consumer: Redis in, Elasticsearch out. Its only HTTP surface is port 3003 for Prometheus scraping.

When this phase is complete:
- event-store-service starts, creates the `detection-events` ES index (if absent), and begins consuming the queue
- Detection events enqueued by ingestion-service appear as indexed documents in Elasticsearch
- `curl localhost:9200/detection-events/_search` returns documents with correctly typed fields
- `GET localhost:3003/metrics` returns `bullmq_queue_depth` and `event_store_jobs_processed_total`

Phases 3 and 4 are still in planning at the time of writing. This phase can be built and verified independently against docker-compose, with test events enqueued manually (see Verification).

---

## Context

**What event-store-service replaces/extends:** Nothing — this is a new service. Its only runtime dependencies are Redis (BullMQ queue backing store) and Elasticsearch, both available since Phase 1's docker-compose.

**Why indexing is async (not synchronous like the alarm path):** Detection events must be stored for audit and search, but a slow Elasticsearch write must not delay the ingestion response. BullMQ decouples the indexing path from the alarm path: if Elasticsearch is briefly unavailable, jobs queue up and retry rather than blocking or dropping events. This is the architectural distinction the demo exists to illustrate.

**Why every event is indexed (not just alarms):** Government audit requirements. Every scan must be provable — the Detection Event Search view shows the complete operational record. Alarm status is a field on the document, not a filter for inclusion.

**Why explicit Elasticsearch mapping:** Without it, Elasticsearch dynamic mapping infers `deviceId`, `eventType`, `platformAlarmStatus`, and `siteId` as `text` (full-text analysed), which breaks exact-match term filter queries. These fields must be `keyword`. `timestamp` must be `date`. `peakCountRate` and `backgroundCountRate` must be `float`. The `payload` object uses the `object` type so that payload fields (`isotope`, `peakCountRate`, etc.) are indexed as first-class document fields and are reachable from standard `multi_match` and `query_string` queries in Phase 6.

**Cross-cutting: graceful shutdown.** All services in this project register SIGTERM and SIGINT handlers that drain in-flight work before exiting. Phase 2 (alert-engine) should be updated to follow this pattern; Phase 5 establishes it clearly. The shutdown sequence for this service: stop HTTP → drain BullMQ worker → close Queue connection → close ES connections.

---

## File Tree

```
apps/event-store-service/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            # entry: bootstrap ES index → start worker → start HTTP server → register shutdown
    ├── server.ts           # Fastify factory: GET /metrics, GET /health
    ├── worker.ts           # BullMQ Worker + Queue (for metrics)
    ├── elasticsearch.ts    # ES client + INDEX_NAME + bootstrapIndex()
    ├── metrics.ts          # prom-client registry, queue depth gauge, jobs counter
    └── logger.ts           # shared pino instance
```

No test file. The spec explicitly excludes event-store-service from unit testing: it is a thin wrapper around BullMQ and Elasticsearch, exercised by the running system during DoD verification.

---

## `apps/event-store-service/package.json`

```json
{
  "name": "@vantage/event-store-service",
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
    "bullmq": "^5.0.0",
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

**`ioredis` is NOT listed as a direct dependency.** BullMQ v5 bundles its own pinned ioredis instance. Installing ioredis separately risks pnpm creating a duplicate that breaks `instanceof` checks inside BullMQ. Use `parseRedisUrl()` to pass plain connection options objects — BullMQ creates and manages the ioredis connections internally.

**`@elastic/elasticsearch` `"^8.0.0"` pin is intentional and critical.** As of early 2026, `npm install @elastic/elasticsearch` (the `latest` tag) resolves to v9.x, which has breaking API changes. This service uses v8.x to match the Elasticsearch 8.17.0 docker-compose image. The v8 client API: `document:` (not `body:`) in index calls; `mappings:` at top level in `indices.create`; `indices.exists()` returns `Promise<boolean>` directly; `errors.ResponseError` for HTTP error handling.

---

## `apps/event-store-service/tsconfig.json`

Standard app tsconfig — identical pattern to Phase 2.

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

Same pattern as alert-engine.

```typescript
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    bindings: (bindings) => ({ ...bindings, service: 'event-store-service' }),
  },
});
```

---

## `src/metrics.ts`

The queue depth gauge uses prom-client's async `collect()` pattern: when `/metrics` is scraped, the gauge calls `queue.getWaitingCount()` + `queue.getActiveCount()` at that moment rather than polling. The `Queue` reference is injected after the worker starts (via `setQueueRef`) so the module can be imported before the queue exists.

```typescript
import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Queue } from 'bullmq';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const jobsProcessedTotal = new Counter({
  name: 'event_store_jobs_processed_total',
  help: 'Total detection events successfully indexed to Elasticsearch',
  registers: [registry],
});

let _queue: Queue | null = null;

export function setQueueRef(queue: Queue): void {
  _queue = queue;
}

new Gauge({
  name: 'bullmq_queue_depth',
  help: 'Number of waiting + active jobs in the detection-events queue',
  registers: [registry],
  async collect() {
    if (!_queue) return;
    const [waiting, active] = await Promise.all([
      _queue.getWaitingCount(),
      _queue.getActiveCount(),
    ]);
    this.set(waiting + active);
  },
});
```

---

## `src/elasticsearch.ts`

Creates the Elasticsearch client and provides `bootstrapIndex()`. `INDEX_NAME` is exported so `worker.ts` can reference it directly — the ES index name and the BullMQ queue name are related but distinct constants; exporting `INDEX_NAME` from here avoids a repeated string literal.

The index is created idempotently: if it already exists the function logs and returns. The `indices.create` call is wrapped in a try/catch that ignores `resource_already_exists_exception` (HTTP 400) — this handles the race condition if two instances of the service start simultaneously during a K8s rolling update.

Using `event.eventId` as the document `_id` makes indexing idempotent — a BullMQ retry of a previously indexed job will overwrite the document rather than create a duplicate.

```typescript
import { Client, errors } from '@elastic/elasticsearch';
import { logger } from './logger.js';

export const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
});

export const INDEX_NAME = 'detection-events';

export async function bootstrapIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: INDEX_NAME });

  if (exists) {
    logger.info({ index: INDEX_NAME }, 'ES index already exists — skipping creation');
    return;
  }

  try {
    await esClient.indices.create({
      index: INDEX_NAME,
      mappings: {
        properties: {
          eventId:             { type: 'keyword' },
          deviceId:            { type: 'keyword' },
          deviceType:          { type: 'keyword' },
          siteId:              { type: 'keyword' },
          timestamp:           { type: 'date' },
          vendorId:            { type: 'keyword' },
          eventType:           { type: 'keyword' },
          platformAlarmStatus: { type: 'keyword' },
          payload: {
            type: 'object',
            properties: {
              type:                 { type: 'keyword' },
              durationMs:           { type: 'integer' },
              peakCountRate:        { type: 'float' },
              backgroundCountRate:  { type: 'float' },
              isotope:              { type: 'keyword' },
              detectorAlarmSubtype: { type: 'keyword' },
            },
          },
        },
      },
    });
    logger.info({ index: INDEX_NAME }, 'ES index created with explicit mapping');
  } catch (err) {
    // Two instances starting simultaneously — second create loses the race; safe to ignore.
    if (err instanceof errors.ResponseError && err.statusCode === 400) {
      logger.info({ index: INDEX_NAME }, 'ES index creation race — already exists');
      return;
    }
    throw err;
  }
}
```

---

## `src/worker.ts`

BullMQ manages its own ioredis connections internally when you pass plain connection options objects (instead of `Redis` instances). This is the recommended approach in BullMQ v5: pass `{ host, port, ... }` and let BullMQ create and manage the underlying connections. The Worker and Queue each receive separate option objects — BullMQ creates separate connections from them.

`parseRedisUrl()` converts a `redis://...` URL string to the plain options object BullMQ expects. BullMQ automatically sets `maxRetriesPerRequest: null` on Worker connections when using this approach (required for its blocking `BRPOP`/`BLMOVE` commands). Do not set it manually on Queue connections — Queue commands should fail fast.

**Retry behaviour:** BullMQ retries a job when the processor throws and the job has `attempts > 1` (set by the producer when enqueuing). This service's worker throws on Elasticsearch failure; retries happen automatically. **Phase 3 (ingestion-service) must enqueue jobs with `attempts: 3, backoff: { type: 'exponential', delay: 1000 }`** — see Inter-Phase Contract below. The worker itself has no retry configuration; it only throws.

**Why `concurrency: 5`:** The simulator fires one event per device every ~15s, but scenario injection fires bursts. Concurrency 5 keeps the queue draining quickly without over-provisioning.

**`id` field on index call:** Using `event.eventId` as the Elasticsearch document `_id` makes indexing idempotent. A job that is retried after a partial ES write will `PUT` the same document again — safe. Uses the exported `INDEX_NAME` constant from `elasticsearch.ts` rather than a repeated string literal.

```typescript
import { Worker, Queue } from 'bullmq';
import { QUEUE_NAMES, type DetectionEvent } from '@vantage/types';
import { esClient, INDEX_NAME } from './elasticsearch.js';
import { jobsProcessedTotal, setQueueRef } from './metrics.js';
import { logger } from './logger.js';

export interface WorkerHandle {
  worker: Worker;
  queue: Queue;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
    db: u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : 0,
  };
}

export function startWorker(redisUrl: string): WorkerHandle {
  const queue = new Queue(QUEUE_NAMES.DETECTION_EVENTS, {
    connection: parseRedisUrl(redisUrl),
  });
  setQueueRef(queue);

  const worker = new Worker<DetectionEvent>(
    QUEUE_NAMES.DETECTION_EVENTS,
    async (job) => {
      const event = job.data;

      await esClient.index({
        index: INDEX_NAME,
        id: event.eventId,
        document: event,
      });

      jobsProcessedTotal.inc();
      logger.info(
        { eventId: event.eventId, jobId: job.id, deviceId: event.deviceId },
        'event indexed',
      );
    },
    {
      connection: parseRedisUrl(redisUrl),
      concurrency: 5,
    },
  );

  // `prev` is the previous job state string — included in signature to match BullMQ v5 types
  worker.on('failed', (job, err, prev) => {
    logger.error(
      {
        err,
        jobId: job?.id,
        eventId: job?.data?.eventId,
        attemptsMade: job?.attemptsMade,
        prev,
      },
      'job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'worker connection error');
  });

  logger.info({ queue: QUEUE_NAMES.DETECTION_EVENTS, concurrency: 5 }, 'BullMQ worker started');

  return { worker, queue };
}
```

---

## `src/server.ts`

Identical pattern to alert-engine's server: Fastify with `loggerInstance`, `/metrics`, and `/health`. No routes for other services — this port is scrape-only.

```typescript
import Fastify from 'fastify';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

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

Startup sequence: bootstrap ES index → start BullMQ worker → start HTTP server → register shutdown handlers. The order matters: the index must exist before the worker begins processing jobs (otherwise the first `esClient.index` call creates a dynamic mapping instead of using the explicit one).

The shutdown sequence mirrors startup in reverse: stop HTTP (no new scrapes), drain the BullMQ worker (in-flight jobs finish), close the metrics Queue connection, close the Elasticsearch connection pool. `worker.close()` waits for in-progress jobs by default — no forced kill. K8s's default `terminationGracePeriodSeconds: 30` is sufficient given typical ES write latency (<100ms).

```typescript
import { bootstrapIndex, esClient } from './elasticsearch.js';
import { startWorker } from './worker.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.error('REDIS_URL is required');
    process.exit(1);
  }

  if (!process.env.ELASTICSEARCH_URL) {
    logger.error('ELASTICSEARCH_URL is required');
    process.exit(1);
  }

  await bootstrapIndex();

  const handle = startWorker(redisUrl);
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();            // stop accepting new HTTP requests
      await handle.worker.close();  // drain in-flight BullMQ jobs
      await handle.queue.close();   // close metrics Queue connection
      await esClient.close();       // close Elasticsearch connection pool
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  const port = Number(process.env.PORT ?? 3003);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'event-store-service ready');
}

main().catch((err) => {
  logger.error({ err }, 'event-store-service startup failed');
  process.exit(1);
});
```

---

## Inter-Phase Contract

Phase 3 (ingestion-service) is the BullMQ producer for the `detection-events` queue. For event-store-service's retry behaviour to work correctly, **Phase 3 must enqueue jobs as follows:**

```typescript
import { QUEUE_NAMES } from '@vantage/types';

// Queue construction — the queue name must match Phase 5's consumer
const queue = new Queue(QUEUE_NAMES.DETECTION_EVENTS, { connection });

// Job name ('detection-event') is a cosmetic label, not the queue name
await queue.add('detection-event', event, {
  jobId: event.eventId,            // BullMQ deduplication — no duplicate while in-flight
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 1000,          // keep last 1000 completed jobs for inspection
  removeOnFail: 500,               // keep last 500 failed jobs for debugging
});
```

- `QUEUE_NAMES.DETECTION_EVENTS` — shared constant from `@vantage/types`; use this in both services when constructing `Queue` and `Worker` instances, never a bare string literal
- `'detection-event'` — the job name passed to `queue.add()` is an arbitrary label (used in logs and Bull Board). It is distinct from the queue name and does not need to match anything in Phase 5.
- `attempts: 3` — BullMQ retries the job up to 3 times if the processor throws
- `backoff: { type: 'exponential', delay: 1000 }` — first retry after ~1s, second after ~2s
- `removeOnComplete` / `removeOnFail` — prevents unbounded Redis memory growth

If Phase 3 enqueues without `attempts`, BullMQ defaults to `attempts: 1` (no retry). The three-attempt retry spec requirement is only satisfied when Phase 3 sets this.

---

## Verification Steps

Run these in order after implementing all files.

**Prerequisite:** `packages/types/src/index.ts` already exports `QUEUE_NAMES` — this was added during Phase 5 planning and is in the file now. No action needed.

**1. Install dependencies**
```bash
pnpm install
```

**2. Typecheck**
```bash
pnpm typecheck
```
Expected: exits 0. No TypeScript errors across the whole monorepo (including the `QUEUE_NAMES` addition to `@vantage/types`).

**3. Lint**
```bash
pnpm lint
```
Expected: exits 0.

**4. Start infrastructure**
```bash
pnpm infra:up
# WSL2 only if not already set:
# sudo sysctl -w vm.max_map_count=262144
```

**5. Start event-store-service**
```bash
cd apps/event-store-service && pnpm start
```
Expected log sequence:
- `"ES index created with explicit mapping"` (or `"ES index already exists"` on subsequent runs)
- `"BullMQ worker started"` with `queue: "detection-events"`, `concurrency: 5`
- `"event-store-service ready"` with `port: 3003`

**6. Verify the index mapping**
```bash
curl -s http://localhost:9200/detection-events/_mapping | python3 -m json.tool
```
Expected: `deviceId`, `eventType`, `platformAlarmStatus`, `siteId` show `"type": "keyword"`; `timestamp` shows `"type": "date"`; `payload` shows `"type": "object"` with `peakCountRate` as `float` and `isotope` as `keyword`.

**7. Enqueue a test job manually**

Run from the service directory so pnpm can resolve `bullmq` and `@vantage/types`:

```bash
cd apps/event-store-service && pnpm tsx --env-file=../../.env - << 'EOF'
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@vantage/types';

function parseRedisUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
    db: u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : 0,
  };
}

const queue = new Queue(QUEUE_NAMES.DETECTION_EVENTS, {
  connection: parseRedisUrl(process.env.REDIS_URL),
});

await queue.add('detection-event', {
  eventId: 'manual-test-001',
  deviceId: 'PM-01',
  deviceType: 'PORTAL_MONITOR',
  siteId: 'POE-ALPHA',
  timestamp: new Date().toISOString(),
  vendorId: 'VANTAGE',
  eventType: 'RADIATION_SCAN',
  platformAlarmStatus: 'CLEAR',
  payload: {
    type: 'RADIATION_SCAN',
    durationMs: 2000,
    peakCountRate: 100,
    backgroundCountRate: 45,
    isotope: null,
    detectorAlarmSubtype: null,
  },
}, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });

await queue.close();
console.log('Job enqueued');
EOF
```

Expected: event-store-service logs `"event indexed"` with `eventId: "manual-test-001"`.

**8. Verify the document in Elasticsearch**
```bash
curl -s http://localhost:9200/detection-events/_search | python3 -m json.tool
```
Expected: one hit with `_id: "manual-test-001"`, correct field values, `payload` object visible.

**9. Verify keyword fields work for exact-match queries**
```bash
curl -s "http://localhost:9200/detection-events/_search" \
  -H "Content-Type: application/json" \
  -d '{"query": {"term": {"deviceId": "PM-01"}}}' | python3 -m json.tool
```
Expected: returns the document. If `deviceId` were mapped as `text`, term queries on exact values would not work.

**10. Verify payload fields are queryable without nested DSL**
```bash
curl -s "http://localhost:9200/detection-events/_search" \
  -H "Content-Type: application/json" \
  -d '{"query": {"range": {"payload.peakCountRate": {"gte": 50}}}}' | python3 -m json.tool
```
Expected: returns the document (peakCountRate: 100 >= 50). This verifies `object` type — with `nested` type this query would return zero results.

**11. Verify Prometheus metrics**
```bash
curl -s http://localhost:3003/metrics | grep -E 'bullmq|event_store'
```
Expected: `event_store_jobs_processed_total` shows 1. `bullmq_queue_depth` shows 0.

**12. Verify idempotent indexing**
Enqueue the same `eventId: "manual-test-001"` job again. Expected: ES document is updated (not duplicated). `_search` still returns one hit.

**13. Verify graceful shutdown**

Press `Ctrl+C` in the terminal where event-store-service is running (sends SIGINT). Expected: logs show `"shutdown signal received"`, `"shutdown complete"`, then process exits 0. No jobs left in `active` state in Redis.

---

## Decisions

**`@elastic/elasticsearch` v8 (not v7 or `@elastic/elasticsearch-js`):** The docker-compose image is 8.17.0. The v8 client has breaking API changes from v7 — the index request uses `document:` not `body:`, and index creation fields are top-level. Using v8 avoids the deprecation shim and matches the K3s Helm chart image version.

**`object` type for payload (not `nested`):** Elasticsearch's `nested` type is designed for arrays of objects where you need to match multiple fields on the same array element. A `DetectionEvent` has exactly one payload object — not an array. Using `nested` for a single embedded object creates the `nested` query DSL requirement throughout Phase 6 without providing any correctness benefit. `object` type maps payload fields as first-class document fields (`payload.peakCountRate`, `payload.isotope`, etc.), searchable via standard `multi_match`, `range`, and `term` queries. This is the correct type for a single embedded object.

**Idempotent indexing via `eventId` as `_id`:** BullMQ retry after a partial ES write would create a duplicate if we used auto-generated `_id`. Using `event.eventId` means a retry is a safe overwrite. The ES `index` API (not `create`) is used specifically because it overwrites on conflict rather than returning 409.

**`INDEX_NAME` exported from `elasticsearch.ts`, `QUEUE_NAMES` from `@vantage/types`:** The ES index name (`INDEX_NAME`) is a detail internal to the event-store-service only, so it lives in `elasticsearch.ts` and is referenced by `worker.ts` via import. The BullMQ queue name (`QUEUE_NAMES.DETECTION_EVENTS`) must match across two services (Phase 3 and Phase 5), so it belongs in the shared types package. Both are typed constants (`as const`) so TypeScript catches typos at compile time.

**BullMQ-managed connections via `parseRedisUrl()` (no direct ioredis dependency):** BullMQ v5 bundles its own pinned ioredis instance. When you pass a plain connection options object (`{ host, port, ... }`) instead of a `Redis` instance, BullMQ creates and manages the underlying connections internally — including setting `maxRetriesPerRequest: null` automatically on Worker connections (required for its blocking `BRPOP`/`BLMOVE` commands). Installing ioredis separately risks pnpm not deduplicating it, which causes `instanceof` checks inside BullMQ to fail silently. The `parseRedisUrl()` helper converts the `REDIS_URL` env var string to the plain options object BullMQ expects.

**Worker and Queue receive separate option objects:** BullMQ Worker uses blocking Redis commands that hold the connection indefinitely; these cannot share a connection with the Queue's non-blocking reads. Passing a separate options object to each causes BullMQ to create two independent connections. This is the same isolation requirement as the explicit two-instance pattern, but managed by BullMQ rather than by this service.

**No process exit on worker error:** A BullMQ worker that loses its Redis connection will automatically reconnect via its internal ioredis reconnect logic and resume consuming. Exiting on `worker.on('error')` would cause unnecessary pod restarts. The `error` event is logged at `error` level for visibility.

**Graceful shutdown via SIGTERM/SIGINT:** `worker.close()` is BullMQ's graceful shutdown — it stops accepting new jobs and waits for in-progress processors to resolve. K8s sends SIGTERM then SIGKILL after `terminationGracePeriodSeconds` (default 30s). Since a typical ES write completes in <100ms, in-flight jobs will drain long before the 30s kill deadline. This is the correct shutdown pattern for all services in this project; Phase 2 (alert-engine) should be updated to follow it.

**Concurrency 5:** The default BullMQ Worker concurrency is 1. Scenario injection fires bursts of events from multiple devices simultaneously. Concurrency 5 keeps queue depth near zero under normal load and handles bursts without visible backpressure.

**Lazy queue reference in metrics (`setQueueRef`):** The `bullmq_queue_depth` gauge's `collect()` needs a `Queue` instance, but the prom-client registry is a module singleton imported before the queue is created. Injecting the queue reference after startup via `setQueueRef` avoids circular imports and keeps `metrics.ts` free of startup-order dependencies. The guard `if (!_queue) return` means early `/metrics` scrapes simply omit the gauge — correct behaviour.

**Port 3003 for metrics only:** The spec assigns 3003 to event-store-service. No other service sends HTTP requests to it; only Prometheus scrapes it. Fastify is used (not a bare `http.createServer`) for consistency with all other services and because `registry.metrics()` is async.
