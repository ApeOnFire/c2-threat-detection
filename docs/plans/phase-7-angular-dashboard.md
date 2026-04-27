---
status: Draft
created: 2026-04-26
updated: 2026-04-26
related_docs:
  - docs/build-spec-vantage-demo.md
  - docs/plans/roadmap.md
  - docs/plans/phase-6-api-service.md
---

# Phase 7: Angular Dashboard

## Objective

Build the `apps/dashboard/` Angular 21 + PrimeNG 21 frontend. When this phase is complete:

- **Live Operations** (default view): three device cards polling `GET /api/devices` every 10s; active alarms panel seeded from `GET /api/alarms?status=ACTIVE` and updated live via WebSocket; Acknowledge button calls `PATCH /api/alarms/:id/acknowledge` and removes the alarm from the panel without page refresh
- **Detection Event Search**: date range, device dropdown, event type dropdown, free-text search backed by `GET /api/events/search`; results table with pagination
- **Alarm History**: paginated table of all alarms with status/device/type/date filters backed by `GET /api/alarms`
- **Test Mode Panel**: collapsible drawer with three scenario buttons; calls `POST /api/scenarios/:name`
- Live Operations view shows `N / total devices online` count derived from the device poll; site header shows the static `POE-ALPHA` label only
- New alarms animate into the Active Alarms panel within 2s of a scenario trigger
- `ng build` produces a dist bundle; `nginx.conf` is prepared for Phase 8 K3s deployment

---

## Context

**API baseline.** All endpoints are implemented by Phase 6's api-service (port 3004). The WebSocket path is `/ws`; messages are `{ type: 'alarm', alarm: Alarm }`. The REST prefix is `/api`. Phase 6's DeviceState type has nullable fields for offline devices (`lastSeen: string | null`, `backgroundCountRate: number | null`).

**Angular in the monorepo.** Angular's TypeScript config is managed by the Angular CLI entirely — `apps/dashboard/tsconfig.json`, `tsconfig.app.json`, and `tsconfig.spec.json` are not extensions of the root `tsconfig.base.json`. `pnpm typecheck` covers only backend services; Angular type errors are caught by `ng build`. ESLint already excludes `apps/dashboard/**` per the root config.

**Proxy in dev.** `ng serve` uses a proxy config to forward `/api` and `/ws` to localhost:3004. All Angular code uses relative URLs (`/api/...`, `/ws`) so no URL changes are needed between dev and production.

**PrimeNG 21.** Uses standalone components, no NgModule-based imports. Requires `provideAnimationsAsync()` and `providePrimeNG()` in `app.config.ts`. Theme configured via preset (`Aura`). Dark mode disabled (clean light UI for the demo).

**No Angular unit tests.** The build spec explicitly excludes Angular from unit testing: it is verified visually. No `spec.ts` files are created.

**nginx in K3s.** The dashboard Dockerfile is a two-stage build: Angular build in `node:22-alpine`, served by `nginx:alpine`. The nginx config must handle SPA routing (`try_files $uri $uri/ /index.html`) and serve compressed assets.

---

## API Contract Reference

All endpoints are relative — `/api/...` and `/ws` work in both dev (proxied) and production (ingress).

| Endpoint | Method | Key params / body | Response shape |
|---|---|---|---|
| `/api/devices` | GET | — | `DeviceState[]` |
| `/api/alarms` | GET | `status`, `deviceId`, `alarmSubtype`, `from`, `to`, `limit`, `offset` | `{ total: number, alarms: Alarm[] }` |
| `/api/alarms/:id` | GET | — | `Alarm` |
| `/api/alarms/:id/acknowledge` | PATCH | — | `Alarm` |
| `/api/events/search` | GET | `q`, `from`, `to`, `deviceId`, `eventType`, `limit`, `offset` | `{ total: number, events: DetectionEvent[] }` |
| `/api/scenarios/:name` | POST | — | `{ ok: true, scenario: string }` |
| `/ws` | WebSocket | — | `{ type: 'alarm', alarm: Alarm }` |

---

## File Tree

```
apps/dashboard/
├── angular.json
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── proxy.conf.json
├── nginx.conf
└── src/
    ├── main.ts
    ├── styles.css
    ├── index.html
    └── app/
        ├── app.config.ts
        ├── app.routes.ts
        ├── app.component.ts
        ├── app.component.html
        ├── models/
        │   └── api.types.ts
        ├── pipes/
        │   └── alarm-label.pipe.ts
        ├── services/
        │   ├── api.service.ts
        │   └── websocket.service.ts
        └── views/
            ├── live-operations/
            │   ├── live-operations.component.ts
            │   ├── live-operations.component.html
            │   ├── device-card/
            │   │   ├── device-card.component.ts
            │   │   └── device-card.component.html
            │   └── active-alarms/
            │       ├── active-alarms.component.ts
            │       └── active-alarms.component.html
            ├── event-search/
            │   ├── event-search.component.ts
            │   └── event-search.component.html
            ├── alarm-history/
            │   ├── alarm-history.component.ts
            │   └── alarm-history.component.html
            └── test-mode-panel/
                ├── test-mode-panel.component.ts
                └── test-mode-panel.component.html
```

---

## Scaffolding

From the repo root:

```bash
cd apps
npx @angular/cli@21 new dashboard \
  --routing \
  --style=css \
  --skip-git \
  --skip-tests \
  --package-manager=pnpm
```

(`--standalone` is the default in Angular 19+ and is not required.)

Then add PrimeNG and supporting packages:

```bash
cd dashboard
pnpm add primeng@^21.0.0 primeicons @primeuix/themes
pnpm add -D @angular/cli@^21.0.0
```

Delete the generated `src/app/app.component.spec.ts` if present. The CLI may generate sample content in `app.component.html` — replace it fully with the content in this plan.

**Accept the generated `main.ts`.** Angular 21 generates a standard bootstrap file with no zone.js import:

```typescript
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch(console.error);
```

Do not add `import 'zone.js'` — Angular 21 is zoneless by default and zone.js is not installed.

**Update the root `tsconfig.json` (monorepo root, not the dashboard's).** Add `"apps/dashboard/**"` to the `"exclude"` array. Without this exclusion, `pnpm typecheck` attempts to compile Angular component files with the Node.js/TypeScript 6 config (no knowledge of `@angular/core`), causing an immediate build failure on `@Component` and `@Injectable` decorators.

```json
{
  "exclude": ["node_modules", "apps/dashboard/**"]
}
```

---

## `apps/dashboard/package.json`

```json
{
  "name": "@vantage/dashboard",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "start": "ng serve --proxy-config proxy.conf.json",
    "dev": "ng serve --proxy-config proxy.conf.json",
    "build": "ng build",
    "typecheck": "tsc --noEmit -p tsconfig.app.json"
  },
  "dependencies": {
    "@angular/animations": "^21.0.0",
    "@angular/common": "^21.0.0",
    "@angular/compiler": "^21.0.0",
    "@angular/core": "^21.0.0",
    "@angular/forms": "^21.0.0",
    "@angular/platform-browser": "^21.0.0",
    "@angular/router": "^21.0.0",
    "@primeuix/themes": "latest",
    "primeicons": "^7.0.0",
    "primeng": "^21.0.0",
    "rxjs": "^7.8.0",
    "tslib": "^2.3.0"
  },
  "devDependencies": {
    "@angular-devkit/build-angular": "^21.0.0",
    "@angular/cli": "^21.0.0",
    "@angular/compiler-cli": "^21.0.0",
    "typescript": "~5.7.0"
  }
}
```

**`@primeuix/themes` version note.** `@primeuix/themes` has independent versioning from PrimeNG — `"latest"` is used as the initial placeholder because the version number does not match `^21.0.0`. After running `pnpm add @primeuix/themes`, check `node_modules/@primeuix/themes/package.json` and replace `"latest"` with the installed version (e.g., `"^1.2.3"`). For `primeicons`, run `pnpm why primeicons` to confirm the version PrimeNG 21 requires and pin accordingly.

**TypeScript version note:** Angular 21 ships with TypeScript ~5.7 (its own pinned version). This is separate from the backend's TypeScript 6.x. The backend root `tsconfig.json` excludes `apps/dashboard/**` so there is no conflict.

**`zone.js` is intentionally absent.** Angular 21 is zoneless by default — `ng new` no longer adds `zone.js` to the project. Do not add it back.

---

## `proxy.conf.json`

```json
{
  "/api": {
    "target": "http://localhost:3004",
    "secure": false,
    "changeOrigin": true
  },
  "/ws": {
    "target": "ws://localhost:3004",
    "ws": true,
    "secure": false
  }
}
```

**WebSocket proxy with Angular 21's esbuild dev server.** Angular 17+ switched to an esbuild-based dev server by default, and multiple Angular CLI issues documented broken WebSocket proxying in early esbuild builds. These may be resolved in Angular 21's CLI, but if `ng serve` fails to establish the WebSocket connection (the Active Alarms panel seeds correctly from REST but never receives live updates), apply this fallback in `angular.json`:

```json
// In projects.dashboard.architect.build — change builder to the webpack-based one:
"builder": "@angular-devkit/build-angular:browser"
```

Test WebSocket proxying immediately during initial setup rather than discovering the issue during the live demo.

---

## `src/app/models/api.types.ts`

TypeScript interfaces mirroring the api-service responses. These duplicate `@vantage/types` intentionally — the Angular app cannot import workspace TypeScript source directly, and adding a build step for the types package is not worth the complexity in a demo.

```typescript
export interface DeviceState {
  deviceId: string;
  deviceType: string;
  lastSeen: string | null;
  backgroundCountRate: number | null;
  status: 'ONLINE' | 'OFFLINE';
}

export interface Alarm {
  id: string;
  deviceId: string;
  siteId: string;
  eventType: string;
  alarmSubtype: string;
  peakCountRate: number | null;
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggeredAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface DetectionEvent {
  eventId: string;
  deviceId: string;
  deviceType: string;
  siteId: string;
  timestamp: string;
  vendorId: string;
  eventType: string;
  platformAlarmStatus: 'CLEAR' | 'ALARM';
  payload: {
    type: string;
    peakCountRate?: number;
    backgroundCountRate?: number;
    isotope?: string | null;
    detectorAlarmSubtype?: string | null;
    durationMs?: number;
    [key: string]: unknown;
  };
}

export interface AlarmsResponse {
  total: number;
  alarms: Alarm[];
}

export interface EventsResponse {
  total: number;
  events: DetectionEvent[];
}

export interface WsMessage {
  type: 'alarm';
  alarm: Alarm;
}
```

---

## `src/app/services/api.service.ts`

```typescript
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Alarm, AlarmsResponse, DeviceState, EventsResponse } from '../models/api.types';

export interface AlarmsParams {
  status?: 'ACTIVE' | 'ACKNOWLEDGED';
  deviceId?: string;
  alarmSubtype?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface EventsParams {
  q?: string;
  from?: string;
  to?: string;
  deviceId?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  getDevices(): Observable<DeviceState[]> {
    return this.http.get<DeviceState[]>('/api/devices');
  }

  getAlarms(params: AlarmsParams = {}): Observable<AlarmsResponse> {
    let p = new HttpParams();
    if (params.status) p = p.set('status', params.status);
    if (params.deviceId) p = p.set('deviceId', params.deviceId);
    if (params.alarmSubtype) p = p.set('alarmSubtype', params.alarmSubtype);
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    if (params.limit != null) p = p.set('limit', params.limit);
    if (params.offset != null) p = p.set('offset', params.offset);
    return this.http.get<AlarmsResponse>('/api/alarms', { params: p });
  }

  acknowledgeAlarm(id: string): Observable<Alarm> {
    return this.http.patch<Alarm>(`/api/alarms/${id}/acknowledge`, {});
  }

  searchEvents(params: EventsParams = {}): Observable<EventsResponse> {
    let p = new HttpParams();
    if (params.q) p = p.set('q', params.q);
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    if (params.deviceId) p = p.set('deviceId', params.deviceId);
    if (params.eventType) p = p.set('eventType', params.eventType);
    if (params.limit != null) p = p.set('limit', params.limit);
    if (params.offset != null) p = p.set('offset', params.offset);
    return this.http.get<EventsResponse>('/api/events/search', { params: p });
  }

  triggerScenario(name: string): Observable<{ ok: boolean; scenario: string }> {
    return this.http.post<{ ok: boolean; scenario: string }>(`/api/scenarios/${name}`, {});
  }
}
```

---

## `src/app/services/websocket.service.ts`

Manages a single WebSocket connection. Reconnects automatically after disconnect. Exposes an Observable of incoming alarm messages. `connect()` is called once in `AppComponent.ngOnInit()` — subsequent calls no-op if already connected.

```typescript
import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import type { WsMessage } from '../models/api.types';

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private ws: WebSocket | null = null;
  private message$ = new Subject<WsMessage>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        this.message$.next(msg);
      } catch {
        // malformed message — ignore
      }
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  messages(): Observable<WsMessage> {
    return this.message$.asObservable();
  }

  ngOnDestroy(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
```

---

## `src/app/app.config.ts`

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import { MessageService } from 'primeng/api';
import Aura from '@primeuix/themes/aura';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    provideHttpClient(),
    MessageService,
    providePrimeNG({
      theme: {
        preset: Aura,
        options: { darkModeSelector: false },
      },
    }),
  ],
};
```

**Angular 21 is zoneless by default.** `provideZoneChangeDetection` is not generated by `ng new` and is not needed here. Zoneless change detection is implicit; signals trigger re-renders automatically when updated.

**`provideAnimationsAsync` compatibility note.** There is a known PrimeNG issue where animations fail at startup when using `provideAnimationsAsync`. If PrimeNG components do not animate or throw DI errors on startup, replace `provideAnimationsAsync()` with `provideAnimations()` imported from `@angular/platform-browser/animations`.

---

## `src/app/app.routes.ts`

```typescript
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./views/live-operations/live-operations.component').then(
        (m) => m.LiveOperationsComponent,
      ),
  },
  {
    path: 'events',
    loadComponent: () =>
      import('./views/event-search/event-search.component').then(
        (m) => m.EventSearchComponent,
      ),
  },
  {
    path: 'alarms',
    loadComponent: () =>
      import('./views/alarm-history/alarm-history.component').then(
        (m) => m.AlarmHistoryComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
```

---

## `src/app/app.component.ts` + `app.component.html`

The app shell: navigation bar, router outlet, and the Test Mode drawer trigger. The Test Mode panel is always in the DOM so scenario buttons work from any view.

```typescript
import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { WebSocketService } from './services/websocket.service';
import { TestModePanelComponent } from './views/test-mode-panel/test-mode-panel.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ButtonModule,
    ToastModule,
    TestModePanelComponent,
  ],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit {
  private ws = inject(WebSocketService);
  testPanelVisible = signal(false);

  ngOnInit(): void {
    this.ws.connect();
  }

  toggleTestPanel(): void {
    this.testPanelVisible.update((v) => !v);
  }
}
```

```html
<!-- app.component.html -->
<div class="app-shell">
  <header class="site-header">
    <div class="header-brand">
      <span class="header-site">POE-ALPHA</span>
      <span class="header-sep">·</span>
      <span class="header-title">Vantage Platform</span>
    </div>
    <nav class="header-nav">
      <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Live Operations</a>
      <a routerLink="/events" routerLinkActive="active">Event Search</a>
      <a routerLink="/alarms" routerLinkActive="active">Alarm History</a>
    </nav>
    <p-button
      label="Test Mode"
      icon="pi pi-play-circle"
      severity="secondary"
      size="small"
      (onClick)="toggleTestPanel()"
    />
  </header>

  <main class="main-content">
    <router-outlet />
  </main>
</div>

<p-toast position="top-right" />
<app-test-mode-panel
  [(visible)]="testPanelVisible"
/>
```

---

## `src/styles.css`

This is the complete file — write it in one pass. CSS for all components is consolidated here; the component sections below contain no separate "Add to styles.css" blocks.

```css
@import 'primeicons/primeicons.css';

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #f8f9fa;
  color: #1a1a2e;
}

/* App shell */
.app-shell { display: flex; flex-direction: column; min-height: 100vh; }

.site-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.75rem 1.5rem;
  background: #1a1a2e;
  color: #fff;
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-brand { display: flex; align-items: center; gap: 0.5rem; }
.header-site  { font-weight: 700; font-size: 1rem; letter-spacing: 0.05em; color: #7dd3fc; }
.header-sep   { color: #475569; }
.header-title { font-size: 0.9rem; color: #94a3b8; }

.header-nav { display: flex; gap: 1.5rem; margin-left: auto; }
.header-nav a {
  color: #94a3b8;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  padding: 0.25rem 0;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.header-nav a:hover,
.header-nav a.active { color: #fff; border-bottom-color: #7dd3fc; }

.main-content { flex: 1; padding: 1.5rem; max-width: 1400px; margin: 0 auto; width: 100%; }

.view-title { font-size: 1.25rem; font-weight: 600; margin: 0 0 1.25rem; color: #1a1a2e; }

/* Shared status badges */
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.6rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.badge-online       { background: #dcfce7; color: #166534; }
.badge-offline      { background: #fee2e2; color: #991b1b; }
.badge-active       { background: #fef3c7; color: #92400e; }
.badge-acknowledged { background: #e2e8f0; color: #475569; }
.badge-norm         { background: #fef3c7; color: #92400e; }
.badge-isotope      { background: #fee2e2; color: #991b1b; }
.badge-alarm        { background: #fee2e2; color: #991b1b; }
.badge-clear        { background: #dcfce7; color: #166534; }

/* Live Operations view */
.live-ops { display: flex; flex-direction: column; gap: 1.5rem; }
.section-header { display: flex; align-items: baseline; gap: 1rem; }
.online-count { font-size: 0.875rem; color: #64748b; }
.device-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }

/* Device card */
.card-header { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem 0; }
.card-id     { font-size: 1.1rem; font-weight: 700; }
.card-body   { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.5rem; }
.card-row    { display: flex; justify-content: space-between; font-size: 0.875rem; }
.label       { color: #64748b; }

/* Active alarms panel */
.alarms-section { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.section-title  { font-size: 1rem; font-weight: 600; margin: 0 0 1rem; display: flex; align-items: center; gap: 0.5rem; }
.alarm-count    { background: #fee2e2; color: #991b1b; font-size: 0.75rem; font-weight: 700; padding: 0.1rem 0.5rem; border-radius: 9999px; }
.empty-state    { color: #94a3b8; font-size: 0.875rem; padding: 1rem 0; text-align: center; }
.alarms-list    { display: flex; flex-direction: column; gap: 0.5rem; }
.alarm-row      { display: grid; grid-template-columns: 140px 80px 90px 80px 100px 1fr; align-items: center; gap: 1rem; padding: 0.625rem 0.75rem; background: #fff7ed; border-radius: 6px; border-left: 3px solid #f97316; font-size: 0.875rem; }
.alarm-device   { font-weight: 600; }
.alarm-time,
.alarm-peak,
.alarm-isotope  { color: #475569; }

/* Event Search and Alarm History — shared filter bar */
.search-bar { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-bottom: 1.25rem; }
.search-input { flex: 1; min-width: 220px; }

/* Test Mode panel */
.test-panel-intro { font-size: 0.8rem; color: #64748b; margin-bottom: 1.25rem; line-height: 1.5; }
.scenario-list    { display: flex; flex-direction: column; gap: 1rem; }
.scenario-card    { background: #f8f9fa; border-radius: 6px; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.scenario-label   { font-weight: 600; font-size: 0.875rem; }
.scenario-desc    { font-size: 0.8rem; color: #64748b; }
.scenario-btn     { width: 100%; }
```

---

## Live Operations View

### `live-operations.component.ts`

```typescript
import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval, switchMap, startWith } from 'rxjs';
import { ApiService } from '../../services/api.service';
import type { DeviceState } from '../../models/api.types';
import { DeviceCardComponent } from './device-card/device-card.component';
import { ActiveAlarmsComponent } from './active-alarms/active-alarms.component';

@Component({
  selector: 'app-live-operations',
  standalone: true,
  imports: [CommonModule, DeviceCardComponent, ActiveAlarmsComponent],
  templateUrl: './live-operations.component.html',
})
export class LiveOperationsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);

  devices = signal<DeviceState[]>([]);
  private sub = new Subscription();

  onlineCount = computed(() => this.devices().filter((d) => d.status === 'ONLINE').length);

  ngOnInit(): void {
    this.sub.add(
      interval(10_000)
        .pipe(startWith(0), switchMap(() => this.api.getDevices()))
        .subscribe((devices) => this.devices.set(devices)),
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
```

### `live-operations.component.html`

```html
<div class="live-ops">
  <div class="section-header">
    <h1 class="view-title">Live Operations</h1>
    <span class="online-count">{{ onlineCount() }} / {{ devices().length }} devices online</span>
  </div>

  <div class="device-grid">
    @for (device of devices(); track device.deviceId) {
      <app-device-card [device]="device" />
    }
  </div>

  <app-active-alarms />
</div>
```

### `device-card.component.ts`

```typescript
import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import type { DeviceState } from '../../../models/api.types';

@Component({
  selector: 'app-device-card',
  standalone: true,
  imports: [CommonModule, CardModule],
  templateUrl: './device-card.component.html',
})
export class DeviceCardComponent {
  device = input.required<DeviceState>();
}
```

### `device-card.component.html`

```html
<p-card>
  <ng-template pTemplate="header">
    <div class="card-header">
      <div class="card-id">{{ device().deviceId }}</div>
      <span class="status-badge" [class]="device().status === 'ONLINE' ? 'badge-online' : 'badge-offline'">
        {{ device().status }}
      </span>
    </div>
  </ng-template>

  <div class="card-body">
    <div class="card-row">
      <span class="label">Type</span>
      <span>{{ device().deviceType }}</span>
    </div>
    <div class="card-row">
      <span class="label">Last Scan</span>
      <span>{{ device().lastSeen ? (device().lastSeen | date:'HH:mm:ss') : '—' }}</span>
    </div>
    <div class="card-row">
      <span class="label">Background</span>
      <span>{{ device().backgroundCountRate != null ? (device().backgroundCountRate + ' cps') : '—' }}</span>
    </div>
  </div>
</p-card>
```

### `active-alarms.component.ts`

Seeds from REST on init. Subscribes to the WebSocket singleton (shared with `AppComponent`) to receive new alarms and prepend them with animation. Acknowledge removes the alarm from the local list when the API confirms success; a loading spinner shows during the in-flight request.

```typescript
import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { trigger, transition, style, animate } from '@angular/animations';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../../services/api.service';
import { WebSocketService } from '../../../services/websocket.service';
import { AlarmLabelPipe } from '../../../pipes/alarm-label.pipe';
import type { Alarm } from '../../../models/api.types';

@Component({
  selector: 'app-active-alarms',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, AlarmLabelPipe],
  templateUrl: './active-alarms.component.html',
  animations: [
    trigger('slideIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(-12px)' }),
        animate('250ms ease-out', style({ opacity: 1, transform: 'translateY(0)' })),
      ]),
    ]),
  ],
})
export class ActiveAlarmsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private ws = inject(WebSocketService);
  private toast = inject(MessageService);

  alarms = signal<Alarm[]>([]);
  acknowledging = signal<Set<string>>(new Set());
  private sub = new Subscription();

  ngOnInit(): void {
    this.api.getAlarms({ status: 'ACTIVE', limit: 20 }).subscribe({
      next: (res) => { this.alarms.set(res.alarms); },
      error: () => {
        this.toast.add({ severity: 'error', summary: 'Load failed', detail: 'Could not load active alarms', life: 5000 });
      },
    });

    this.sub.add(
      this.ws.messages().subscribe((msg) => {
        if (msg.type === 'alarm' && msg.alarm.status === 'ACTIVE') {
          this.alarms.update((prev) =>
            [msg.alarm, ...prev.filter((a) => a.id !== msg.alarm.id)].slice(0, 20),
          );
        }
      }),
    );
  }

  acknowledge(alarm: Alarm): void {
    this.acknowledging.update((s) => new Set([...s, alarm.id]));
    this.api.acknowledgeAlarm(alarm.id).subscribe({
      next: () => {
        this.alarms.update((prev) => prev.filter((a) => a.id !== alarm.id));
        this.acknowledging.update((s) => { const n = new Set(s); n.delete(alarm.id); return n; });
      },
      error: () => {
        this.acknowledging.update((s) => { const n = new Set(s); n.delete(alarm.id); return n; });
      },
    });
  }

  isAcknowledging(id: string): boolean {
    return this.acknowledging().has(id);
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
```

### `active-alarms.component.html`

```html
<div class="alarms-section">
  <h2 class="section-title">
    Active Alarms
    @if (alarms().length > 0) {
      <span class="alarm-count">{{ alarms().length }}</span>
    }
  </h2>

  @if (alarms().length === 0) {
    <div class="empty-state">No active alarms</div>
  } @else {
    <div class="alarms-list">
      @for (alarm of alarms(); track alarm.id) {
        <div class="alarm-row" [@slideIn]>
          <span class="status-badge" [class]="alarm.alarmSubtype === 'ISOTOPE_IDENTIFIED' ? 'badge-isotope' : 'badge-norm'">
            {{ alarm.alarmSubtype | alarmLabel }}
          </span>
          <span class="alarm-device">{{ alarm.deviceId }}</span>
          <span class="alarm-time">{{ alarm.triggeredAt | date:'HH:mm:ss' }}</span>
          <span class="alarm-peak">{{ alarm.peakCountRate != null ? (alarm.peakCountRate + ' cps') : '—' }}</span>
          <span class="alarm-isotope">{{ alarm.isotope ?? '—' }}</span>
          <p-button
            label="Acknowledge"
            size="small"
            severity="secondary"
            [loading]="isAcknowledging(alarm.id)"
            (onClick)="acknowledge(alarm)"
          />
        </div>
      }
    </div>
  }
</div>
```

**`alarmLabel` pipe** — add as a standalone pipe in `src/app/pipes/alarm-label.pipe.ts`:

```typescript
import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'alarmLabel', standalone: true })
export class AlarmLabelPipe implements PipeTransform {
  transform(value: string): string {
    const labels: Record<string, string> = {
      NORM_THRESHOLD: 'NORM Threshold',
      ISOTOPE_IDENTIFIED: 'Isotope ID',
    };
    return labels[value] ?? value;
  }
}
```

---

## Event Search View

### `event-search.component.ts`

```typescript
import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import type { DetectionEvent } from '../../models/api.types';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-event-search',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, SelectModule, DatePickerModule, ButtonModule, TableModule, TagModule],
  templateUrl: './event-search.component.html',
})
export class EventSearchComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  q = signal('');
  deviceId = signal('');
  eventType = signal('');
  dateRange = signal<Date[] | null>(null);

  events = signal<DetectionEvent[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(0);

  deviceOptions = signal([{ label: 'All Devices', value: '' }]);

  eventTypeOptions = [
    { label: 'All Types', value: '' },
    { label: 'Radiation Scan', value: 'RADIATION_SCAN' },
    { label: 'X-Ray Scan', value: 'XRAY_SCAN' },
    { label: 'CBRN Detection', value: 'CBRN_DETECTION' },
  ];

  ngOnInit(): void {
    this.api.getDevices().subscribe((devices) => {
      this.deviceOptions.set([
        { label: 'All Devices', value: '' },
        ...devices.map((d) => ({ label: d.deviceId, value: d.deviceId })),
      ]);
    });
  }

  search(resetPage = true): void {
    if (resetPage) this.page.set(0);
    const range = this.dateRange();
    this.loading.set(true);
    this.api.searchEvents({
      q: this.q() || undefined,
      deviceId: this.deviceId() || undefined,
      eventType: this.eventType() || undefined,
      from: range?.[0]?.toISOString(),
      to: range?.[1]?.toISOString(),
      limit: PAGE_SIZE,
      offset: this.page() * PAGE_SIZE,
    }).subscribe({
      next: (res) => { this.events.set(res.events); this.total.set(res.total); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Search failed', detail: 'Could not reach api-service', life: 5000 });
      },
    });
  }

  onPageChange(event: { first: number }): void {
    this.page.set(event.first / PAGE_SIZE);
    this.search(false);
  }

  clear(): void {
    this.q.set(''); this.deviceId.set(''); this.eventType.set(''); this.dateRange.set(null);
    this.events.set([]); this.total.set(0);
  }

  pageSize = PAGE_SIZE;
}
```

### `event-search.component.html`

```html
<div>
  <h1 class="view-title">Detection Event Search</h1>

  <div class="search-bar">
    <input pInputText placeholder="Search (device, isotope, status…)" [ngModel]="q()" (ngModelChange)="q.set($event)" class="search-input" />
    <p-select [options]="deviceOptions()" [ngModel]="deviceId()" (ngModelChange)="deviceId.set($event)" optionLabel="label" optionValue="value" placeholder="Device" />
    <p-select [options]="eventTypeOptions" [ngModel]="eventType()" (ngModelChange)="eventType.set($event)" optionLabel="label" optionValue="value" placeholder="Event Type" />
    <p-datepicker [ngModel]="dateRange()" (ngModelChange)="dateRange.set($event)" selectionMode="range" placeholder="Date range" dateFormat="yy-mm-dd" showIcon />
    <p-button label="Search" icon="pi pi-search" (onClick)="search()" />
    <p-button label="Clear" severity="secondary" (onClick)="clear()" />
  </div>

  <p-table
    [value]="events()"
    [lazy]="true"
    [first]="page() * pageSize"
    [totalRecords]="total()"
    [rows]="pageSize"
    [paginator]="true"
    [loading]="loading()"
    (onPage)="onPageChange($event)"
    styleClass="p-datatable-sm"
  >
    <ng-template pTemplate="header">
      <tr>
        <th>Timestamp</th>
        <th>Device</th>
        <th>Type</th>
        <th>Peak (cps)</th>
        <th>Isotope</th>
        <th>Status</th>
      </tr>
    </ng-template>
    <ng-template pTemplate="body" let-event>
      <tr>
        <td>{{ event.timestamp | date:'yyyy-MM-dd HH:mm:ss' }}</td>
        <td>{{ event.deviceId }}</td>
        <td>{{ event.eventType }}</td>
        <td>{{ event.payload?.peakCountRate ?? '—' }}</td>
        <td>{{ event.payload?.isotope ?? '—' }}</td>
        <td>
          <span class="status-badge" [class]="event.platformAlarmStatus === 'ALARM' ? 'badge-alarm' : 'badge-clear'">
            {{ event.platformAlarmStatus }}
          </span>
        </td>
      </tr>
    </ng-template>
    <ng-template pTemplate="emptymessage">
      <tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:2rem">Run a search to see results</td></tr>
    </ng-template>
  </p-table>
</div>
```

---

## Alarm History View

### `alarm-history.component.ts`

```typescript
import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { AlarmLabelPipe } from '../../pipes/alarm-label.pipe';
import type { Alarm } from '../../models/api.types';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-alarm-history',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, DatePickerModule, ButtonModule, TableModule, AlarmLabelPipe],
  templateUrl: './alarm-history.component.html',
})
export class AlarmHistoryComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  status = signal<'ACTIVE' | 'ACKNOWLEDGED' | ''>('');
  deviceId = signal('');
  alarmSubtype = signal('');
  dateRange = signal<Date[] | null>(null);

  alarms = signal<Alarm[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(0);

  statusOptions = [
    { label: 'All', value: '' },
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Acknowledged', value: 'ACKNOWLEDGED' },
  ];

  deviceOptions = signal([{ label: 'All', value: '' }]);

  subtypeOptions = [
    { label: 'All', value: '' },
    { label: 'NORM Threshold', value: 'NORM_THRESHOLD' },
    { label: 'Isotope ID', value: 'ISOTOPE_IDENTIFIED' },
  ];

  pageSize = PAGE_SIZE;

  ngOnInit(): void {
    this.load();
    this.api.getDevices().subscribe((devices) => {
      this.deviceOptions.set([
        { label: 'All', value: '' },
        ...devices.map((d) => ({ label: d.deviceId, value: d.deviceId })),
      ]);
    });
  }

  clear(): void {
    this.status.set('');
    this.deviceId.set('');
    this.alarmSubtype.set('');
    this.dateRange.set(null);
    this.load();
  }

  load(resetPage = true): void {
    const range = this.dateRange();
    // Skip load if user has selected the start of a date range but not the end yet.
    // PrimeNG fires ngModelChange after the first date selection with range[1] = null.
    if (range && !range[1]) return;
    if (resetPage) this.page.set(0);
    this.loading.set(true);
    this.api.getAlarms({
      status: (this.status() as 'ACTIVE' | 'ACKNOWLEDGED') || undefined,
      deviceId: this.deviceId() || undefined,
      alarmSubtype: this.alarmSubtype() || undefined,
      from: range?.[0]?.toISOString(),
      to: range?.[1]?.toISOString(),
      limit: PAGE_SIZE,
      offset: this.page() * PAGE_SIZE,
    }).subscribe({
      next: (res) => { this.alarms.set(res.alarms); this.total.set(res.total); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Load failed', detail: 'Could not load alarm history', life: 5000 });
      },
    });
  }

  onPageChange(event: { first: number }): void {
    this.page.set(event.first / PAGE_SIZE);
    this.load(false);
  }
}
```

### `alarm-history.component.html`

```html
<div>
  <h1 class="view-title">Alarm History</h1>

  <div class="search-bar">
    <p-select [options]="statusOptions" [ngModel]="status()" (ngModelChange)="status.set($event); load()" optionLabel="label" optionValue="value" placeholder="Status" />
    <p-select [options]="deviceOptions()" [ngModel]="deviceId()" (ngModelChange)="deviceId.set($event); load()" optionLabel="label" optionValue="value" placeholder="Device" />
    <p-select [options]="subtypeOptions" [ngModel]="alarmSubtype()" (ngModelChange)="alarmSubtype.set($event); load()" optionLabel="label" optionValue="value" placeholder="Type" />
    <p-datepicker [ngModel]="dateRange()" (ngModelChange)="dateRange.set($event); load()" selectionMode="range" placeholder="Date range" dateFormat="yy-mm-dd" showIcon />
    <p-button label="Clear" severity="secondary" (onClick)="clear()" />
  </div>

  <p-table
    [value]="alarms()"
    [lazy]="true"
    [first]="page() * pageSize"
    [totalRecords]="total()"
    [rows]="pageSize"
    [paginator]="true"
    [loading]="loading()"
    (onPage)="onPageChange($event)"
    styleClass="p-datatable-sm"
  >
    <ng-template pTemplate="header">
      <tr>
        <th>Triggered</th>
        <th>Device</th>
        <th>Type</th>
        <th>Peak (cps)</th>
        <th>Isotope</th>
        <th>Status</th>
        <th>Acknowledged</th>
      </tr>
    </ng-template>
    <ng-template pTemplate="body" let-alarm>
      <tr>
        <td>{{ alarm.triggeredAt | date:'yyyy-MM-dd HH:mm:ss' }}</td>
        <td>{{ alarm.deviceId }}</td>
        <td>{{ alarm.alarmSubtype | alarmLabel }}</td>
        <td>{{ alarm.peakCountRate ?? '—' }}</td>
        <td>{{ alarm.isotope ?? '—' }}</td>
        <td>
          <span class="status-badge" [class]="alarm.status === 'ACTIVE' ? 'badge-active' : 'badge-acknowledged'">
            {{ alarm.status }}
          </span>
        </td>
        <td>{{ alarm.acknowledgedAt ? (alarm.acknowledgedAt | date:'HH:mm:ss') : '—' }}</td>
      </tr>
    </ng-template>
    <ng-template pTemplate="emptymessage">
      <tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:2rem">No alarms found</td></tr>
    </ng-template>
  </p-table>
</div>
```

---

## Test Mode Panel

### `test-mode-panel.component.ts`

```typescript
import { Component, inject, signal, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DrawerModule } from 'primeng/drawer';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';

interface Scenario {
  name: string;
  label: string;
  description: string;
  severity: 'warning' | 'danger' | 'info';
}

@Component({
  selector: 'app-test-mode-panel',
  standalone: true,
  imports: [CommonModule, DrawerModule, ButtonModule],
  templateUrl: './test-mode-panel.component.html',
})
export class TestModePanelComponent {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  visible = model<boolean>(false);
  loading = signal<Record<string, boolean>>({});

  scenarios: Scenario[] = [
    {
      name: 'norm-threshold',
      label: 'NORM Threshold Exceedance',
      description: 'PM-01 · 320 cps — exceeds background threshold',
      severity: 'warning',
    },
    {
      name: 'isotope-identified',
      label: 'Isotope Identification',
      description: 'PM-02 · Cs-137 identified · 180 cps',
      severity: 'danger',
    },
    {
      name: 'concurrent',
      label: 'Concurrent Alarms',
      description: 'PM-01 + PM-02 simultaneously',
      severity: 'danger',
    },
  ];

  trigger(scenario: Scenario): void {
    this.loading.update((s) => ({ ...s, [scenario.name]: true }));
    this.api.triggerScenario(scenario.name).subscribe({
      next: () => {
        this.loading.update((s) => ({ ...s, [scenario.name]: false }));
        this.toast.add({ severity: 'success', summary: 'Scenario triggered', detail: scenario.label, life: 3000 });
      },
      error: () => {
        this.loading.update((s) => ({ ...s, [scenario.name]: false }));
        this.toast.add({ severity: 'error', summary: 'Scenario failed', detail: 'Check that all services are running', life: 4000 });
      },
    });
  }

  isLoading(name: string): boolean {
    return !!this.loading()[name];
  }
}
```

### `test-mode-panel.component.html`

```html
<p-drawer [(visible)]="visible" header="Test Mode — Scenario Simulation" position="right" [style]="{ width: '380px' }">
  <div class="test-panel-intro">
    Inject a simulated detection event to exercise the full alarm path end-to-end. Alarms will appear in the Active Alarms panel within 2 seconds.
  </div>

  <div class="scenario-list">
    @for (scenario of scenarios; track scenario.name) {
      <div class="scenario-card">
        <div class="scenario-label">{{ scenario.label }}</div>
        <div class="scenario-desc">{{ scenario.description }}</div>
        <p-button
          [label]="'Trigger ' + scenario.label"
          [severity]="scenario.severity"
          size="small"
          [loading]="isLoading(scenario.name)"
          (onClick)="trigger(scenario)"
          styleClass="scenario-btn"
        />
      </div>
    }
  </div>
</p-drawer>
```

---

## `nginx.conf`

Used in the Dockerfile for the K3s deployment. Serves the Angular `dist/browser` output with SPA routing fallback.

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache hashed assets aggressively; index.html must not be cached
    location ~* \.(js|css|woff2?|svg|png|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location = /index.html {
        add_header Cache-Control "no-store";
    }
}
```

---

## `angular.json` — key settings

The CLI generates this. Verify or update these fields after scaffolding:

- Under `projects.dashboard.architect.build.options`: Angular 17+ generates `outputPath` as an object `{ "base": "dist/dashboard" }` — accept the CLI default. The final bundle lands at `dist/dashboard/browser/`. Note this path for Phase 8 when the Dockerfile copies build output to `/usr/share/nginx/html`. Verify `"baseHref": "/"` is set (usually the default).

`baseHref: "/"` ensures Angular's router and asset paths work correctly when served by the nginx ingress at the root path.

---

## Verification Steps

Run these after api-service and the full backend stack are running.

**1. Install and build**
```bash
cd apps/dashboard
pnpm install
pnpm run build
```
Expected: no errors, `dist/` produced.

**2. Typecheck**
```bash
pnpm run typecheck
```
Expected: exits 0.

**3. Dev server**
```bash
pnpm run start
```
Expected: `ng serve` starts on `http://localhost:4200`, proxy forwarding `/api` and `/ws` to port 3004 confirmed in startup output.

**4. Live Operations — device cards**

Open `http://localhost:4200`. Three device cards should appear, each showing ONLINE with last scan time and background count rate.

**5. Live Operations — WebSocket alarm**

Open the Test Mode panel (button in header). Click "Trigger NORM Threshold Exceedance". Expected within 2 seconds:
- Toast notification confirms the scenario was triggered
- A new alarm row animates into the Active Alarms panel (orange left border, NORM Threshold badge)

**6. Acknowledge alarm**

Click "Acknowledge" on the active alarm. The button shows a loading spinner, then the row disappears from the Active Alarms panel once the server confirms (within ~500ms). In the Alarm History view, the alarm should now show `ACKNOWLEDGED` status with an `acknowledgedAt` time.

**7. Device offline detection**

Stop the telemetry-simulator. Wait 35 seconds. Refresh (or wait for the next 10s poll). All three device cards should show `OFFLINE` with dashes for last scan and background rate.

**8. Event Search**

Navigate to Event Search. Click Search without filters — recent detection events should appear in the table (requires event-store-service to have indexed at least one event). Verify filtering by device and by `platformAlarmStatus = ALARM` (enter "ALARM" in the search field) narrows results.

**9. Alarm History**

Navigate to Alarm History. Table should load with all alarms, newest first. Filter by `Status: Active` — only unacknowledged alarms shown. Verify `total` count updates when filters are applied (paginator shows correct page count).

**10. Concurrent scenario**

Trigger "Concurrent Alarms". Two alarm rows should animate into the Active Alarms panel, one for PM-01 and one for PM-02.

---

## Decisions

**Relative URLs + proxy (not environment files):** Using relative `/api` and `/ws` URLs means zero URL differences between dev and production. The Angular dev server proxy handles the forwarding in dev; the nginx ingress handles it in production. Environment files with hardcoded hosts would require synchronised updates across environments and add deployment risk.

**WebSocket service as singleton, connected from AppComponent:** The WS connection is shared across all views. Connecting in AppComponent ensures the connection is established as soon as the shell loads, not deferred until the Live Operations view is first rendered. This means if a user is on the Alarm History view and a scenario fires, the WS still receives the message (useful if they then navigate to Live Operations).

**Active Alarms seeded from REST then updated by WS:** The WS only delivers new alarms — it has no concept of "replay existing state." The initial REST call seeds the list; the WS appends new alarms. The `filter(a => a.id !== msg.alarm.id)` dedup in the WS handler prevents duplicates if an alarm is both in the initial load and arrives over WS.

**Acknowledge on confirmed success:** The alarm is removed from the Active Alarms list when the API's `PATCH` response confirms success (`next:` callback), not on button click. The `acknowledging` Set manages the button loading spinner during the in-flight request. A visible error toast fires on failure so the operator knows to retry. The `PATCH` is low-risk but removing on click with no rollback was judged worse UX than a ~50ms delay for network confirmation.

**`model()` for drawer visibility:** `TestModePanelComponent` uses Angular's `model()` signal for two-way binding with `AppComponent`. This is the Angular 17+ idiomatic pattern for two-way bindable inputs, replacing `@Input`/`@Output` pairs for this case.

**`AlarmLabelPipe` as standalone pipe in `src/app/pipes/`:** Shared between `ActiveAlarmsComponent` and `AlarmHistoryComponent`. Standalone pipes in Angular 21 are imported directly into each component's `imports` array — no shared module needed.

**PrimeNG `DatePicker` (not `Calendar`):** PrimeNG v17+ renamed `Calendar` to `DatePicker`. Angular 21 aligns with PrimeNG 21 which uses `DatePickerModule` from `primeng/datepicker`.

**No `p-menubar` for navigation:** The build spec calls for three view tabs. A custom header with styled `routerLink` anchors gives more visual control than PrimeNG's `p-menubar` (which is designed for dropdown menus) and is simpler to style for the C2 aesthetic (dark header bar, underline active tab).

**Single app-level `<p-toast>` and root-provided `MessageService`:** `MessageService` is provided in `app.config.ts` (not per-component), and one `<p-toast>` lives in `AppComponent`. All components — including `TestModePanelComponent` and the three views — inject the same singleton. This keeps toasts visually consistent (one overlay stack, top-right) and avoids component-level toast islands that fight each other for position. Components call `this.toast.add(...)` on error without owning their own toast outlet.

**Active Alarms capped at 20 most-recent:** The WS handler and the initial REST seed both cap the list at 20 entries (`limit: 20` on the REST call; `.slice(0, 20)` after prepending a new WS alarm). In a sustained demo with many scenario triggers, an unbounded list would overflow the viewport and obscure the Acknowledge buttons. Twenty entries is enough to demonstrate concurrent alarms without degrading usability. The Alarm History view is the correct place for full history.

**`@primeuix/themes` (not `@primeng/themes`):** PrimeNG migrated its theme package from `@primeng/themes` to `@primeuix/themes`. The old package still works in PrimeNG 21 for backward compatibility but is unmaintained. New projects should reference `@primeuix/themes` directly.

**Angular 21 is zoneless by default:** `ng new` in Angular 21 no longer generates a zone-based project. There is no `zone.js` dependency and no `provideZoneChangeDetection` call. Zoneless change detection is implicit. Signal mutations (`signal.set()`, `signal.update()`) trigger re-renders directly — the `interval()` polling and WebSocket subscription patterns in this plan work correctly because they terminate in signal updates.

**Dynamic device options loaded from `GET /api/devices`:** Both `EventSearchComponent` and `AlarmHistoryComponent` populate their device dropdowns from the live API rather than hardcoded values. This ensures the filter options match the actual devices regardless of how the telemetry simulator is configured.

**Date range guard in `AlarmHistoryComponent.load()`:** PrimeNG's `DatePicker` fires `ngModelChange` after the first date in a range selection (before the end date is chosen), with `value = [Date, null]`. Without the guard `if (range && !range[1]) return`, this triggers a superfluous API call mid-selection. The guard makes loading wait until both dates are present (or the picker is cleared, in which case `range` is null). The same issue does not affect `EventSearchComponent` because that view uses an explicit Search button rather than auto-loading on filter change.
