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
