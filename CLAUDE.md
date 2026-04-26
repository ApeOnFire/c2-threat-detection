# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Vantage Platform Demo** — a radiation detection C2 (command and control) operator platform. Kubernetes, distributed systems and TypeScript. Built as a pnpm monorepo targeting K3s deployment.

## Commands

Run all from workspace root unless noted.

```bash
# Quality checks
pnpm typecheck          # tsc --noEmit (covers all apps + packages)
pnpm lint               # eslint . (flat config)
pnpm test               # vitest run
pnpm test --watch       # vitest watch mode

# Infrastructure (Docker Compose)
pnpm infra:up           # start postgres + redis + elasticsearch
pnpm infra:down
pnpm infra:logs

# Per-service (cd into apps/{service} first)
pnpm start              # tsx --env-file=../../.env src/index.ts
pnpm dev                # tsx watch --env-file=../../.env src/index.ts
```

Copy `.env.example` → `.env` before running services locally.

## Architecture

**Two data paths with different guarantees:**

| Path | Flow | Guarantee |
|------|------|-----------|
| Alarm (sync) | ingestion → alert-engine (HTTP, 5s timeout) | fail-fast, 503 visible |
| Indexing (async) | ingestion → BullMQ → event-store | retry 3×, exponential backoff |

**Services and ports:**

| Service | Port |
|---------|------|
| telemetry-simulator | 3000 |
| ingestion-service | 3001 |
| alert-engine | 3002 |
| event-store-service | 3003 |
| api-service | 3004 |

**Infrastructure:** PostgreSQL 18 (alarms, rules), Redis 8 (BullMQ queues, device heartbeat TTLs), Elasticsearch 8 (event history).

## Key Patterns

**No compile step.** `tsx` runs TypeScript directly. `@vantage/types` exports `.ts` source files (`allowImportingTsExtensions: true`). No build output directory.

**Pure evaluation function.** `alert-engine/src/evaluate.ts` exports `evaluate(event, rules)` with no side effects — returns `{ alarmTriggered, alarmSubtype? }`. The HTTP handler wraps it with DB writes and notifications. Keep this boundary clean.

**Rule hot-reload via LISTEN/NOTIFY.** alert-engine holds a dedicated `pg.Client` (not from pool) subscribed to `LISTEN alarm_rules_updated`. A PostgreSQL trigger fires on any `alarm_rules` change. The dedicated client is intentional — a pool would silently drop the subscription.

**Device liveness via Redis TTL.** Heartbeats write `device:state:{deviceId}` with a 30s TTL. No explicit "offline" message — key expiry signals it. api-service checks Redis; absent key → `status: OFFLINE`.

**Idempotent Elasticsearch indexing.** event-store-service uses `event.eventId` as the Elasticsearch `_id`, so BullMQ retries are safe overwrites.

**platformAlarmStatus ownership.** ingestion-service unconditionally overwrites this field from the alert-engine verdict, not the device's own value. `detectorAlarmSubtype` (the device's classification) is distinct from platform `alarmSubtype`.

## Shared Types

`packages/types/src/index.ts` — the canonical source for all cross-service types. Import as `@vantage/types`. Key types: `DetectionEvent`, `Heartbeat`, `EvaluateResult`, `Alarm`, `DeviceState`.

`DetectionEvent.payload` is a discriminated union (`RadiationPayload | XrayPayload | CbrnPayload`).

## TypeScript Setup

- ESM throughout (`"type": "module"` in all packages)
- `NodeNext` module resolution
- Strict mode enabled in `tsconfig.base.json`
- Root `tsconfig.json` covers all apps and packages (used by `pnpm typecheck`)
- Each app/package has its own `tsconfig.json` extending base

## Testing Conventions

- Vitest 4.x; test files named `*.test.ts` co-located with source
- `app.inject()` for HTTP handler tests (no port binding, no supertest)
- `msw` v2 for mocking outbound HTTP (intercepts native `fetch` via undici; nock incompatible with Node 22 fetch)
- `vi.hoisted()` required when spy initialization must precede `vi.mock()`
- PostgreSQL `NUMERIC` columns arrive as strings from `pg`; coerce with `Number()`

## Infra Notes

- All services bind `host: '0.0.0.0'` (required for Docker/K3s inter-container routing)
- `alarm_rules` seed UUIDs use `0001-...` / `0002-...` prefix so lexicographic sort = evaluation priority
- Migrations run programmatically at startup (node-pg-migrate); idempotent and safe to re-run

