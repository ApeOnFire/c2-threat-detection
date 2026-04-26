import type { FastifyInstance } from 'fastify';
import { pool, mapAlarmRow, type AlarmRow } from '../db.js';

interface AlarmsQuery {
  limit?: string;
  offset?: string;
  status?: string;       // 'ACTIVE' | 'ACKNOWLEDGED'
  deviceId?: string;
  alarmSubtype?: string;
  from?: string;         // triggeredAt range start (ISO8601)
  to?: string;           // triggeredAt range end (ISO8601)
}

export async function alarmsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: AlarmsQuery }>(
    '/api/alarms',
    async (request) => {
      const limitRaw = Number(request.query.limit ?? 50);
      const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 0), 200);
      const offsetRaw = Number(request.query.offset ?? 0);
      const offset = Math.max(Number.isNaN(offsetRaw) ? 0 : offsetRaw, 0);
      const { status, deviceId, alarmSubtype, from, to } = request.query;

      // Build parameterised WHERE clause dynamically.
      // filterParams is shared between the COUNT and SELECT queries; LIMIT/OFFSET
      // are appended after the filter params for the SELECT only.
      const conditions: string[] = [];
      const filterParams: unknown[] = [];

      if (status) {
        filterParams.push(status);
        conditions.push(`status = $${filterParams.length}`);
      }
      if (deviceId) {
        filterParams.push(deviceId);
        conditions.push(`device_id = $${filterParams.length}`);
      }
      if (alarmSubtype) {
        filterParams.push(alarmSubtype);
        conditions.push(`alarm_subtype = $${filterParams.length}`);
      }
      if (from) {
        filterParams.push(from);
        conditions.push(`triggered_at >= $${filterParams.length}`);
      }
      if (to) {
        filterParams.push(to);
        conditions.push(`triggered_at <= $${filterParams.length}`);
      }

      const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const n = filterParams.length;

      const [countResult, rowsResult] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT COUNT(*) FROM alarms ${whereClause}`,
          filterParams,
        ),
        pool.query<AlarmRow>(
          `SELECT id, device_id, site_id, event_type, alarm_subtype,
                  peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
           FROM alarms
           ${whereClause}
           ORDER BY triggered_at DESC
           LIMIT $${n + 1} OFFSET $${n + 2}`,
          [...filterParams, limit, offset],
        ),
      ]);

      return {
        total: Number(countResult.rows[0].count),
        alarms: rowsResult.rows.map(mapAlarmRow),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/alarms/:id',
    async (request, reply) => {
      const result = await pool.query<AlarmRow>(
        `SELECT id, device_id, site_id, event_type, alarm_subtype,
                peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at
         FROM alarms WHERE id = $1`,
        [request.params.id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Alarm not found' });
      }

      return mapAlarmRow(result.rows[0]);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/alarms/:id/acknowledge',
    async (request, reply) => {
      // Single UPDATE ... RETURNING — 404 if no row matched, otherwise return updated alarm.
      // COALESCE preserves the original acknowledged_at if already acknowledged (idempotent).
      const result = await pool.query<AlarmRow>(
        `UPDATE alarms
         SET status = 'ACKNOWLEDGED', acknowledged_at = COALESCE(acknowledged_at, NOW())
         WHERE id = $1
         RETURNING id, device_id, site_id, event_type, alarm_subtype,
                   peak_count_rate, isotope, status, triggered_at, acknowledged_at, created_at`,
        [request.params.id],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Alarm not found' });
      }

      return mapAlarmRow(result.rows[0]);
    },
  );
}
