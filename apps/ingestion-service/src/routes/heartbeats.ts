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
