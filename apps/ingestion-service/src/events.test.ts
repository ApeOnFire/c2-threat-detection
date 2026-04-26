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
  Queue: vi.fn().mockImplementation(function () {
    return {
      add: mockQueueAdd,
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// heartbeatsRoutes imports redis.ts which instantiates Redis at module eval time.
// Mocking ioredis prevents a real connection attempt even though no heartbeat
// requests are made in these tests.
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return {
      hset: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      pipeline: vi.fn().mockReturnValue({
        hset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      }),
      quit: vi.fn().mockResolvedValue('OK'),
    };
  }),
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
