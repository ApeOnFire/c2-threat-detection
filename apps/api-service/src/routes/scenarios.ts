import type { FastifyInstance } from 'fastify';
import { logger } from '../logger.js';

export async function scenariosRoutes(app: FastifyInstance) {
  app.post<{ Params: { name: string } }>(
    '/api/scenarios/:name',
    async (request, reply) => {
      const { name } = request.params;
      const simulatorUrl = process.env.TELEMETRY_SIMULATOR_URL;

      if (!simulatorUrl) {
        logger.error({ scenario: name }, 'TELEMETRY_SIMULATOR_URL not configured');
        return reply.status(503).send({ error: 'Simulator not configured' });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${simulatorUrl}/scenario/${name}`, {
          method: 'POST',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status === 404) {
          return reply.status(404).send({ error: `Unknown scenario: ${name}` });
        }

        if (!response.ok) {
          logger.warn({ name, status: response.status }, 'scenario delivery failed');
          return reply.status(502).send({ error: 'Scenario delivery failed' });
        }

        return reply.send({ ok: true, scenario: name });
      } catch (err) {
        clearTimeout(timeout);
        logger.warn({ err, name }, 'simulator unreachable');
        return reply.status(502).send({ error: 'Simulator unreachable' });
      }
    },
  );
}
