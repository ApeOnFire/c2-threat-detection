import { buildServer } from './server.js';
import { queue, connection } from './queue.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

async function main() {
  const missing = ['REDIS_URL', 'ALERT_ENGINE_URL'].filter(
    (v) => !process.env[v],
  );
  if (missing.length > 0) {
    logger.error({ missing }, 'required env vars not set');
    process.exit(1);
  }

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'ingestion-service ready');

  const shutdown = async () => {
    logger.info('shutdown signal received — closing gracefully');
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('shutdown timeout')), 10_000);
      t.unref();
    });
    await Promise.race([
      (async () => {
        await app.close();
        await queue.close();
        await connection.quit();
        await redis.quit();
      })(),
      timeout,
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
}

main().catch((err) => {
  logger.error({ err }, 'ingestion-service startup failed');
  process.exit(1);
});
