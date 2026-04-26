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
