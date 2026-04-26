import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner as migrate } from 'node-pg-migrate';
import { loadRules, startRuleListener, stopRuleListener, pool } from './db.js';
import { buildServer } from './server.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '..', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }

  await migrate({
    databaseUrl: process.env.DATABASE_URL,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: (msg: string) => logger.debug({ migration: true }, msg),
  });
  logger.info('database migrations applied');

  await loadRules();
  await startRuleListener();

  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3002);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'alert-engine ready');

  const shutdown = async () => {
    logger.info('shutdown signal received — closing gracefully');
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('shutdown timeout')), 10_000);
      t.unref();
    });
    await Promise.race([
      (async () => {
        await app.close();
        await stopRuleListener();
        await pool.end();
      })(),
      timeout,
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
  process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
}

main().catch((err) => {
  logger.error({ err }, 'alert-engine startup failed');
  process.exit(1);
});
