import type { FastifyInstance } from 'fastify';
import { pool, mapAlarmRow, type AlarmRow } from '../db.js';
import { broadcast } from '../ws.js';
import { logger } from '../logger.js';

interface NotifyBody {
  alarmId: string;
  alarmSubtype: string;
  deviceId: string;
  siteId: string;
  timestamp: string;
}

export async function notifyRoutes(app: FastifyInstance) {
  app.post<{ Body: NotifyBody }>(
    '/api/internal/alarms/notify',
    async (request, reply) => {
      const body = request.body;

      if (!body?.alarmId) {
        return reply.status(400).send({ error: 'alarmId is required' });
      }

      const traceId = request.headers['x-trace-id'] as string | undefined;

      const result = await pool.query<AlarmRow>(
        `SELECT id, device_id, site_id, event_type, alarm_subtype,
                peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
         FROM alarms WHERE id = $1`,
        [body.alarmId],
      );

      if (result.rows.length === 0) {
        // alert-engine commits before calling notify, so this path should never fire.
        // Broadcasting a partial payload would produce a message the dashboard cannot
        // parse (no `alarm` field), so we drop the broadcast and surface the anomaly.
        logger.error({ alarmId: body.alarmId, traceId }, 'alarm not found in PG during notify — broadcast dropped');
        return reply.status(204).send();
      }

      broadcast({ type: 'alarm', alarm: mapAlarmRow(result.rows[0]) });
      logger.info({ alarmId: body.alarmId, traceId }, 'alarm notified to WS clients');
      return reply.status(204).send();
    },
  );
}
