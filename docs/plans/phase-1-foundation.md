---
status: Draft
created: 2026-04-24
updated: 2026-04-25
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
---

# Phase 1: Monorepo Foundation

## Objective

Establish the pnpm monorepo with shared TypeScript types, consistent tooling config, and local development infrastructure. No service code. No tests beyond "vitest exits 0 with zero test files."

When this phase is complete, any subsequent phase can scaffold a new service into `apps/` and immediately have:
- `@vantage/types` importable
- TypeScript checking working
- ESLint working
- A running PostgreSQL, Redis, and Elasticsearch to connect to

---

## File Tree

```
/
├── package.json                   # workspace root
├── pnpm-workspace.yaml
├── tsconfig.json                  # root — covers all packages + apps for tsc --noEmit
├── tsconfig.base.json             # shared compiler options, extended by each app
├── eslint.config.mjs              # ESLint 9 flat config
├── vitest.config.ts               # root vitest — picks up *.test.ts in all apps
├── docker-compose.yml             # local dev infra: PG + Redis + ES
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       └── ci.yml             # typecheck + lint + test (build job added in Phase 11)
└── packages/
    └── types/
        ├── package.json
        ├── tsconfig.json
        └── src/
            └── index.ts           # all shared types
```

`apps/` does not exist yet. Each service phase creates its own `apps/{service}/` subtree.

---

## Files

### `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### `package.json`

```json
{
  "name": "vantage-demo",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "engines": {
    "node": ">=22.0.0",
    "pnpm": ">=10.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "infra:logs": "docker compose logs -f"
  },
  "devDependencies": {
    "typescript": "^6.0.0",
    "typescript-eslint": "^8.0.0",
    "eslint": "^9.0.0",
    "vitest": "^4.0.0",
    "@types/node": "^22.0.0"
  }
}
```

**`"type": "module"`** is required at root and in every `package.json` in the monorepo. With `"module": "NodeNext"` in tsconfig, TypeScript determines ESM vs CJS from the nearest `package.json`'s `type` field. Without `"type": "module"`, TypeScript would treat `.ts` source as CommonJS, conflicting with NodeNext's expectation for ESM source files. All apps and packages in this monorepo are ESM.

### `tsconfig.base.json`

Shared compiler options. Every app's `tsconfig.json` extends this.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  }
}
```

**`allowImportingTsExtensions`:** required because `@vantage/types` exports TypeScript source directly (no compile step). TypeScript resolves the workspace package via its `exports` field to `./src/index.ts`. Without this flag, TypeScript refuses to import a `.ts` file from a non-emitting context.

**`allowImportingTsExtensions` requires `noEmit: true` or `emitDeclarationOnly: true`.** The root `tsconfig.json` sets `noEmit: true`. Individual app tsconfigs that extend `tsconfig.base.json` must also include `"noEmit": true` — they are checked only, never compiled. Services run via `tsx` which handles this natively.

### `tsconfig.json` (root)

Used by `pnpm typecheck` (`tsc --noEmit`). Covers all packages and apps.

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": [
    "packages/*/src/**/*.ts",
    "apps/*/src/**/*.ts",
    "vitest.config.ts"
  ]
}
```

Each app also has its own `tsconfig.json` that extends `tsconfig.base.json` and adds `"include": ["src/**/*.ts"]`. App tsconfigs are used for IDE support (VS Code picks up the nearest tsconfig.json). The root tsconfig is what the CI typecheck step runs.

**Pattern for app tsconfigs** (applied in every subsequent phase):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

### `eslint.config.mjs`

ESLint 9 flat config. Covers all TypeScript files in the monorepo.

```javascript
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'apps/dashboard/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
```

`apps/dashboard/**` is excluded because Angular manages its own ESLint config via the Angular CLI.

### `vitest.config.ts`

Root Vitest config. As apps with tests are added, Vitest discovers `*.test.ts` files in all `apps/*/src/` directories.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
```

**`passWithNoTests: true`** is required. Vitest exits with code 1 when no test files are found. Phase 1 has no test files by design. Without this flag, `pnpm test` would fail in CI until Phase 2 adds the first test.

### `packages/types/package.json`

```json
{
  "name": "@vantage/types",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

The `exports` field points to the TypeScript source directly. tsx resolves this at runtime via the pnpm workspace symlink in `node_modules/@vantage/types`. TypeScript follows the same path during type checking. `"type": "module"` is required here (see root `package.json` note above).

### `packages/types/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

### `packages/types/src/index.ts`

The canonical type definitions. Transcribed directly from the spec. Do not abbreviate or omit the stub types — their presence makes the envelope pattern legible.

```typescript
// Envelope — common across all device types and vendors
export interface DetectionEvent {
  eventId: string;
  deviceId: string;
  deviceType: string;
  siteId: string;
  timestamp: string;          // ISO8601
  vendorId: string;
  eventType: 'RADIATION_SCAN' | 'XRAY_SCAN' | 'CBRN_DETECTION';
  // Set by ingestion-service from alert-engine's evaluation result — not by the device.
  // Simulator always sends 'CLEAR' as a placeholder; ingestion-service unconditionally
  // overwrites this with the platform's verdict before enqueuing to BullMQ.
  platformAlarmStatus: 'CLEAR' | 'ALARM';
  payload: RadiationPayload | XrayPayload | CbrnPayload;
}

// Radiation-specific payload — the only type implemented in this demo
export interface RadiationPayload {
  type: 'RADIATION_SCAN';
  durationMs: number;
  peakCountRate: number;
  backgroundCountRate: number;
  isotope: string | null;
  // The detector's own alarm classification — set by the simulator based on simulated scan data.
  // Distinct from alert-engine's alarmSubtype (which is the platform's rule evaluation result).
  // null = detector did not identify an alarm condition in the raw scan data.
  detectorAlarmSubtype: 'NORM_THRESHOLD' | 'ISOTOPE_IDENTIFIED' | null;
}

// Stub types — not implemented; present to make the envelope pattern legible
export interface XrayPayload {
  type: 'XRAY_SCAN';
  [key: string]: unknown;
}

export interface CbrnPayload {
  type: 'CBRN_DETECTION';
  [key: string]: unknown;
}

// Heartbeat — device liveness signal, not stored in Elasticsearch
// deviceType is included so the Redis device state is self-describing.
// In real deployments the device communicates its type on connection; including it
// in the heartbeat mirrors that pattern without requiring a separate registration step.
export interface Heartbeat {
  deviceId: string;
  deviceType: string;
  timestamp: string;         // ISO8601
  backgroundCountRate: number;
  status: 'ONLINE';
}

// Shape returned by alert-engine POST /evaluate
export interface EvaluateResult {
  alarmTriggered: boolean;
  alarmId?: string;
  alarmSubtype?: string;  // string, not a literal union — new modalities add new subtypes
}

// Shape returned by GET /api/devices
export interface DeviceState {
  deviceId: string;
  deviceType: string;
  lastSeen: string;          // ISO8601
  backgroundCountRate: number;
  status: 'ONLINE' | 'OFFLINE';
}

// Alarm record as stored in PostgreSQL and returned by GET /api/alarms
export interface Alarm {
  id: string;
  deviceId: string;
  siteId: string;
  eventType: string;
  alarmSubtype: string;
  peakCountRate: number | null;
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggeredAt: string;       // ISO8601
  acknowledgedAt: string | null;
  createdAt: string;         // ISO8601
}
```

### `docker-compose.yml`

Verbatim from the spec, with the Redis volume omission noted.

```yaml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: vantage
      POSTGRES_PASSWORD: vantage
      POSTGRES_DB: vantage
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vantage"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.17.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - xpack.security.http.ssl.enabled=false
      - xpack.security.enrollment.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data
    ulimits:
      memlock:
        soft: -1
        hard: -1
      nofile:
        soft: 65536
        hard: 65536
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health | grep -v '\"status\":\"red\"'"]
      interval: 10s
      timeout: 10s
      retries: 12

volumes:
  postgres-data:
  elasticsearch-data:
```

Redis has no named volume — BullMQ job loss on Docker restart is acceptable in local dev.

**WSL2 prerequisite:** before `docker compose up`, Elasticsearch requires `vm.max_map_count >= 262144`:

```bash
# One-time for current session:
sudo sysctl -w vm.max_map_count=262144

# Permanent (add to /etc/sysctl.d/99-elasticsearch.conf):
echo "vm.max_map_count=262144" | sudo tee /etc/sysctl.d/99-elasticsearch.conf
```

Without this, Elasticsearch exits immediately with a bootstrap check failure.

### `.env.example`

```
# Copy to .env and set values for local development
# Never commit .env
#
# Load in local dev: tsx --env-file=../../.env src/index.ts
# (path assumes service is at apps/{service}/ — adjust depth if needed)

# Infrastructure
DATABASE_URL=postgresql://vantage:vantage@localhost:5432/vantage
REDIS_URL=redis://localhost:6379
ELASTICSEARCH_URL=http://localhost:9200

# Inter-service URLs (local dev ports — overridden by Helm values.yaml in K3s)
# telemetry-simulator : 3000
# ingestion-service   : 3001
# alert-engine        : 3002
# event-store-service : 3003  (metrics only — no inbound requests from other services)
# api-service         : 3004
INGESTION_SERVICE_URL=http://localhost:3001
ALERT_ENGINE_URL=http://localhost:3002
API_SERVICE_URL=http://localhost:3004
TELEMETRY_SIMULATOR_URL=http://localhost:3000
```

**`tsx --env-file`:** Node supports `--env-file` natively (since Node 20; we're on Node 22 LTS). tsx passes through Node flags. Each service's `start` script should be `tsx --env-file=../../.env src/index.ts` in local dev. No `dotenv` package required.

### `.github/workflows/ci.yml`

Basic quality gate — three parallel jobs, no Docker build (added in Phase 11 when Dockerfiles exist).

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

Phase 11 extends this file to add a `build` job (Docker builds) and adds a separate `deploy.yml`.

### `.gitignore`

```
# Dependencies
node_modules/
.pnpm-store/

# TypeScript build artifacts
dist/
*.tsbuildinfo
*.js.map

# Environment
.env
.env.local

# Test output
coverage/

# OS / editor
.DS_Store
Thumbs.db
*.swp
.vscode/settings.json

# Docker volumes (local data)
# (managed by docker-compose, not in repo)
```

---

## Verification Steps

Run these in order after implementing all files above.

**1. Install dependencies**
```bash
pnpm install
```
Expected: lock file written, `node_modules/@vantage/types` symlink created pointing to `packages/types`.

**2. Typecheck**
```bash
pnpm typecheck
```
Expected: exits 0. No errors. (The root tsconfig includes `packages/*/src/**/*.ts` which covers `packages/types/src/index.ts`.)

**3. Lint**
```bash
pnpm lint
```
Expected: exits 0. No lint errors in `packages/types/src/index.ts`.

**4. Test**
```bash
pnpm test
```
Expected: exits 0. Vitest reports "No test files found" or 0 tests run. This is correct — no tests exist yet.

**5. Local infrastructure**
```bash
# WSL2 only, if not already set:
sudo sysctl -w vm.max_map_count=262144

pnpm infra:up
```
Expected: three containers start. After ~30 seconds, all pass their healthchecks.

**6. Verify infrastructure health**
```bash
docker compose ps
```
Expected: all three services show `healthy` status.

```bash
# PostgreSQL
docker compose exec postgres pg_isready -U vantage

# Redis
docker compose exec redis redis-cli ping

# Elasticsearch
curl -s http://localhost:9200/_cluster/health | python3 -m json.tool
```
Expected: PostgreSQL prints `accepting connections`, Redis returns `PONG`, Elasticsearch returns `{"status":"green",...}` or `{"status":"yellow",...}` (yellow is normal for single-node).

---

## Decisions

**Why pnpm (not npm or yarn)?** The spec requires it. pnpm workspaces are the standard for TypeScript monorepos — symlink-based node_modules, strict by default, fast installs.

**Why export TypeScript source from `@vantage/types` instead of compiled JS?** No compile step is the explicit constraint in the spec. tsx handles TypeScript source at runtime. TypeScript 6 + NodeNext module resolution understands `.ts` exports from workspace packages. The alternative — building the types package to JS+d.ts before other packages can use it — adds friction with no benefit in a tsx/no-compile project.

**Why `allowImportingTsExtensions`?** This flag is the correct TypeScript mechanism to allow importing `.ts` files in a noEmit context. Without it, TypeScript would error when it resolves `@vantage/types` to `./src/index.ts`. The flag was introduced specifically for tsx-style projects where there is no emit step.

**Why `"types": ["node"]` in `tsconfig.base.json`?** TypeScript 6.0 changed the default for `types` from an implicit wildcard (all `@types/*` packages in `node_modules` are included) to an explicit empty array (`[]`). Without the explicit `["node"]`, TypeScript no longer auto-includes `@types/node`, which means `process`, `Buffer`, `__dirname`, and all other Node globals stop resolving. Every service in this monorepo depends on Node built-ins. Setting `"types": ["node"]` in the shared base config ensures all apps inherit it without each needing to redeclare it.

**Why exclude `apps/dashboard/**` from ESLint?** Angular uses its own ESLint config (`@angular-eslint`). The root ESLint config uses `typescript-eslint` which does not understand Angular templates. Running both configs in the same process would require complex setup not worth the effort for a demo.

**Why no `apps/` directory in Phase 1?** Each service has non-trivial scaffolding (package.json, tsconfig, Dockerfile, src/). Creating empty shells invites drift between the scaffold and the actual implementation. Service directories are created when the service is actually built, ensuring the config reflects the actual code.

**Where does `tsx` get installed?** `tsx` is a devDependency in each individual `apps/{service}/package.json`, not at workspace root. Each service's `package.json` will have `"devDependencies": { "tsx": "^4.0.0" }` and a `"scripts": { "start": "tsx --env-file=../../.env src/index.ts", "dev": "tsx watch --env-file=../../.env src/index.ts" }`. In tsx 4.x, `watch` is a subcommand; Node flags like `--env-file` follow it. This is established as the standard service scaffold pattern starting in Phase 2.
