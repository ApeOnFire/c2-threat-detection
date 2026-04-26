import { buildServer } from './server.js';
import { startDetectionLoop, startHeartbeatLoop, stopAllLoops } from './loops.js';
import { ingestionUrl } from './emit.js';
import { logger } from './logger.js';

async function main() {
  logger.info({ ingestionUrl }, 'telemetry-simulator starting');

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'telemetry-simulator ready');

  startHeartbeatLoop();
  startDetectionLoop();

  const shutdown = async () => {
    logger.info('shutdown signal received — closing gracefully');
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('shutdown timeout')), 10_000);
      t.unref();
    });
    await Promise.race([
      (async () => {
        stopAllLoops();
        await app.close();
      })(),
      timeout,
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
}

main().catch((err) => {
  logger.error({ err }, 'telemetry-simulator startup failed');
  process.exit(1);
});
