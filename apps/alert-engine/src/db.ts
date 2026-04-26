import { Pool, Client } from 'pg';
import { setRules } from './rules.js';
import { logger } from './logger.js';
import type { AlarmRule } from './types.js';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg returns PostgreSQL NUMERIC columns as strings to avoid float precision loss.
// AlarmRule.threshold is typed as number | null; coerce on load so the in-memory
// cache always has the correct runtime type.
type AlarmRuleRow = Omit<AlarmRule, 'threshold'> & { threshold: string | null };

export async function loadRules(): Promise<void> {
  const result = await pool.query<AlarmRuleRow>(
    `SELECT id, event_type, field, operator, threshold, alarm_subtype, enabled
     FROM alarm_rules
     WHERE enabled = true
     ORDER BY id ASC`,
  );
  setRules(
    result.rows.map((row) => ({
      ...row,
      threshold: row.threshold !== null ? Number(row.threshold) : null,
    })),
  );
  logger.info({ count: result.rows.length }, 'alarm rules loaded');
}

export async function startRuleListener(): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();
  await client.query('LISTEN alarm_rules_updated');

  client.on('notification', () => {
    loadRules().catch((err) => {
      logger.error({ err }, 'failed to reload alarm rules after notification');
    });
  });

  client.on('error', (err) => {
    // Unrecoverable — let the process restart (K8s/tsx watch will handle it)
    logger.error({ err }, 'pg listener connection error — exiting');
    process.exit(1);
  });

  logger.info('listening for alarm_rules_updated notifications');
}
