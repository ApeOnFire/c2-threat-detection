import type { FastifyInstance } from 'fastify';
import type { DetectionEvent, RadiationPayload } from '@vantage/types';
import { evaluate } from '../evaluate.js';
import { getRules } from '../rules.js';
import { pool } from '../db.js';
import { evaluateDurationSeconds } from '../metrics.js';
import { logger } from '../logger.js';

export async function evaluateRoutes(app: FastifyInstance) {
  app.post<{ Body: DetectionEvent }>('/evaluate', async (request, reply) => {
    const end = evaluateDurationSeconds.startTimer();
    const event = request.body;
    const traceId = request.headers['x-trace-id'] as string | undefined;

    const result = evaluate(event, getRules());

    if (!result.alarmTriggered) {
      end();
      return reply.send({ alarmTriggered: false });
    }

    // TypeScript narrows here: result is { alarmTriggered: true; alarmSubtype: string }

    const radiationPayload =
      event.payload.type === 'RADIATION_SCAN'
        ? (event.payload as RadiationPayload)
        : null;

    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO alarms
         (device_id, site_id, event_type, alarm_subtype, peak_count_rate, isotope, triggered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        event.deviceId,
        event.siteId,
        event.eventType,
        result.alarmSubtype,
        radiationPayload?.peakCountRate ?? null,
        radiationPayload?.isotope ?? null,
        event.timestamp,
      ],
    );

    const alarmId = insertResult.rows[0].id;

    end();

    // Best-effort: fire and forget. api-service does not exist until Phase 6.
    notifyApiService(
      { alarmId, alarmSubtype: result.alarmSubtype, event },
      traceId,
    );

    return reply.send({
      alarmTriggered: true,
      alarmId,
      alarmSubtype: result.alarmSubtype,
    });
  });
}

interface NotifyPayload {
  alarmId: string;
  alarmSubtype: string;
  event: DetectionEvent;
}

function notifyApiService(
  payload: NotifyPayload,
  traceId: string | undefined,
): void {
  const apiServiceUrl = process.env.API_SERVICE_URL;
  if (!apiServiceUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  fetch(`${apiServiceUrl}/api/internal/alarms/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(traceId ? { 'X-Trace-Id': traceId } : {}),
    },
    body: JSON.stringify({
      alarmId: payload.alarmId,
      alarmSubtype: payload.alarmSubtype,
      deviceId: payload.event.deviceId,
      siteId: payload.event.siteId,
      timestamp: payload.event.timestamp,
    }),
    signal: controller.signal,
  })
    .catch((err: unknown) => {
      logger.warn(
        { err, alarmId: payload.alarmId, traceId },
        'api-service notify failed — alarm persisted, notification dropped',
      );
    })
    .finally(() => clearTimeout(timeout));
}
