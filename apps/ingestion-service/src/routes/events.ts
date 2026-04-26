import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DetectionEvent, EvaluateResult } from '@vantage/types';
import { queue } from '../queue.js';
import { ingestionEventsTotal } from '../metrics.js';
import { logger } from '../logger.js';

export async function eventsRoutes(app: FastifyInstance) {
  app.post<{ Body: DetectionEvent }>('/events', async (request, reply) => {
    const body = request.body;

    if (!body?.deviceId || !body?.eventType || !body?.payload || !body?.timestamp) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }

    const traceId =
      (request.headers['x-trace-id'] as string | undefined) ?? randomUUID();

    // Normalise: device IDs to uppercase, timestamp to strict ISO8601
    let normalizedTimestamp: string;
    try {
      normalizedTimestamp = new Date(body.timestamp).toISOString();
    } catch {
      return reply.status(400).send({ error: 'Invalid timestamp' });
    }

    const event: DetectionEvent = {
      ...body,
      deviceId: body.deviceId.toUpperCase(),
      timestamp: normalizedTimestamp,
    };

    // Alarm path — synchronous. Failure here is immediate and visible (503).
    const alertEngineUrl = process.env.ALERT_ENGINE_URL;
    if (!alertEngineUrl) {
      logger.error({ traceId }, 'ALERT_ENGINE_URL not configured');
      return reply.status(503).send({ error: 'Alert engine not configured' });
    }

    let evaluateResult: EvaluateResult;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${alertEngineUrl}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trace-Id': traceId,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.error(
          { traceId, status: response.status },
          'alert-engine returned error',
        );
        return reply.status(503).send({ error: 'Alert engine evaluation failed' });
      }

      evaluateResult = (await response.json()) as EvaluateResult;
    } catch (err) {
      clearTimeout(timeout);
      logger.error({ err, traceId }, 'alert-engine unreachable');
      return reply.status(503).send({ error: 'Alert engine unreachable' });
    }

    // Enrich — ingestion-service unconditionally overwrites platformAlarmStatus
    // with the platform's verdict. The simulator sends 'CLEAR' as a placeholder.
    const enrichedEvent: DetectionEvent = {
      ...event,
      platformAlarmStatus: evaluateResult.alarmTriggered ? 'ALARM' : 'CLEAR',
    };

    // Indexing path — best-effort. Alarm is already durable in PostgreSQL.
    // jobId makes the enqueue idempotent: BullMQ will not add a duplicate job
    // while one with the same ID is already in the queue.
    try {
      await queue.add('detection-event', enrichedEvent, { jobId: enrichedEvent.eventId });
    } catch (err) {
      logger.error({ err, traceId }, 'enqueue failed — alarm persisted, event not indexed');
    }

    ingestionEventsTotal.inc({
      eventType: enrichedEvent.eventType,
      platformAlarmStatus: enrichedEvent.platformAlarmStatus,
    });

    logger.info(
      {
        traceId,
        deviceId: enrichedEvent.deviceId,
        platformAlarmStatus: enrichedEvent.platformAlarmStatus,
      },
      'event processed',
    );

    return reply.status(202).header('X-Trace-Id', traceId).send({ received: true });
  });
}
