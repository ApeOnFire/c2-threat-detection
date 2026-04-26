import type { DetectionEvent, Heartbeat } from '@vantage/types';
import { logger } from './logger.js';

export const ingestionUrl =
  process.env.INGESTION_SERVICE_URL ?? 'http://localhost:3001';

export async function emitEvent(event: DetectionEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${ingestionUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ingestion-service rejected event: HTTP ${res.status}`);
    }
    logger.debug({ deviceId: event.deviceId }, 'emitted event');
  } finally {
    clearTimeout(timeout);
  }
}

export async function emitHeartbeat(heartbeat: Heartbeat): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${ingestionUrl}/heartbeats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeat),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`ingestion-service rejected heartbeat: HTTP ${res.status}`);
    }
    logger.debug({ deviceId: heartbeat.deviceId }, 'emitted heartbeat');
  } finally {
    clearTimeout(timeout);
  }
}
