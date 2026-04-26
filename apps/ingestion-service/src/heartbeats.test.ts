import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Heartbeat } from '@vantage/types';

const mockPipelineExec = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return {
      pipeline: vi.fn().mockReturnValue({
        hset: vi.fn().mockReturnThis(),
        expire: vi.fn().mockReturnThis(),
        exec: mockPipelineExec,
      }),
      quit: vi.fn().mockResolvedValue('OK'),
    };
  }),
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function () {
    return {
      add: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
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
