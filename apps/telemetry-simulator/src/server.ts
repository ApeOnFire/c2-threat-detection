import Fastify from 'fastify';
import { runScenario, UnknownScenarioError } from './scenarios.js';
import { registry } from './metrics.js';
import { logger } from './logger.js';

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger });

  app.post<{ Params: { name: string } }>(
    '/scenario/:name',
    async (request, reply) => {
      const { name } = request.params;
      try {
        logger.info({ scenario: name }, 'scenario requested');
        await runScenario(name);
        return reply.send({ ok: true, scenario: name });
      } catch (err) {
        if (err instanceof UnknownScenarioError) {
          return reply.status(404).send({ error: err.message });
        }
        logger.warn({ err, scenario: name }, 'scenario emit failed');
        return reply
          .status(502)
          .send({ error: 'failed to deliver scenario event to ingestion-service' });
      }
    },
  );

  app.get('/metrics', async (_request, reply) => {
    const output = await registry.metrics();
    return reply
      .header('Content-Type', registry.contentType)
      .send(output);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
