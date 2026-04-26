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
