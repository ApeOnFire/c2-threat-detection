import { bootstrapIndex, esClient } from './elasticsearch.js';
import { startWorker } from './worker.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.error('REDIS_URL is required');
    process.exit(1);
  }

  if (!process.env.ELASTICSEARCH_URL) {
    logger.error('ELASTICSEARCH_URL is required');
    process.exit(1);
  }

  await bootstrapIndex();

  const handle = startWorker(redisUrl);
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();            // stop accepting new HTTP requests
      await handle.worker.close();  // drain in-flight BullMQ jobs
      await handle.queue.close();   // close metrics Queue connection
      await esClient.close();       // close Elasticsearch connection pool
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  const port = Number(process.env.PORT ?? 3003);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'event-store-service ready');
}

main().catch((err) => {
  logger.error({ err }, 'event-store-service startup failed');
  process.exit(1);
});
