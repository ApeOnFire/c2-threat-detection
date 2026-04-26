import { buildServer } from './server.js';
import { startDetectionLoop, startHeartbeatLoop } from './loops.js';
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
}

main().catch((err) => {
  logger.error({ err }, 'telemetry-simulator startup failed');
  process.exit(1);
});
