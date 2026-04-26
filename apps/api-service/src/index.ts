import { buildServer } from './server.js';
import { initWebSocket, closeWebSocket } from './ws.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { esClient } from './elasticsearch.js';
import { logger } from './logger.js';

async function main() {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'ELASTICSEARCH_URL'].filter(
    (v) => !process.env[v],
  );
  if (missing.length > 0) {
    logger.error({ missing }, 'required env vars not set');
    process.exit(1);
  }

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3004);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'api-service ready');

  // Must be called after app.listen() — the WS server attaches to the bound http.Server
  initWebSocket(app.server);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();       // stop accepting new HTTP requests
      await closeWebSocket();  // close all WebSocket connections
      await pool.end();        // drain pg connection pool
      await redis.quit();      // close Redis connection
      await esClient.close();  // close ES connection pool
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  logger.error({ err }, 'api-service startup failed');
  process.exit(1);
});
