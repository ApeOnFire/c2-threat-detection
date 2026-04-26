import crypto from 'node:crypto';
import type { DetectionEvent, Heartbeat, RadiationPayload } from '@vantage/types';
import { DEVICES, SITE_ID, VENDOR_ID, type Device } from './devices.js';
import { emitEvent, emitHeartbeat } from './emit.js';
import { logger } from './logger.js';

const parsedIntervalMs = Number(process.env.EVENT_INTERVAL_MS ?? 15_000);
const EVENT_INTERVAL_MS = Number.isFinite(parsedIntervalMs) && parsedIntervalMs >= 1000 ? parsedIntervalMs : 15_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

// Box-Muller transform — generates a normally distributed sample.
// Returns an integer clamped to a minimum of 1 (count rates are always positive).
// u1 is resampled if exactly 0 to avoid Math.log(0) = -Infinity → NaN.
function normalSample(mean: number, sigma: number): number {
  let u1: number;
  do { u1 = Math.random(); } while (u1 === 0);
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(1, Math.round(mean + sigma * z));
}

function buildDetectionEvent(device: Device): DetectionEvent {
  // backgroundCountRate is generated first; peakCountRate is clamped to be at
  // least as large — a detector's peak cannot be below the ambient background.
  const backgroundCountRate = normalSample(45, 5);
  const peakCountRate = Math.max(backgroundCountRate, normalSample(45, 8));

  const payload: RadiationPayload = {
    type: 'RADIATION_SCAN',
    durationMs: 2000,
    peakCountRate,
    backgroundCountRate,
    isotope: null,
    detectorAlarmSubtype: null,
  };

  return {
    eventId: crypto.randomUUID(),
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    siteId: SITE_ID,
    timestamp: new Date().toISOString(),
    vendorId: VENDOR_ID,
    eventType: 'RADIATION_SCAN',
    platformAlarmStatus: 'CLEAR',   // ingestion-service unconditionally overwrites this
    payload,
  };
}

function buildHeartbeat(device: Device): Heartbeat {
  return {
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    timestamp: new Date().toISOString(),
    backgroundCountRate: normalSample(45, 5),
    status: 'ONLINE',
  };
}

const handles: NodeJS.Timeout[] = [];

export function startDetectionLoop(): void {
  logger.info(
    { intervalMs: EVENT_INTERVAL_MS, deviceCount: DEVICES.length },
    'starting detection event loops',
  );
  for (const device of DEVICES) {
    handles.push(setInterval(() => {
      emitEvent(buildDetectionEvent(device)).catch((err) => {
        logger.warn({ err, deviceId: device.deviceId }, 'failed to emit event');
      });
    }, EVENT_INTERVAL_MS));
  }
}

export function startHeartbeatLoop(): void {
  logger.info(
    { intervalMs: HEARTBEAT_INTERVAL_MS, deviceCount: DEVICES.length },
    'starting heartbeat loops',
  );
  for (const device of DEVICES) {
    handles.push(setInterval(() => {
      emitHeartbeat(buildHeartbeat(device)).catch((err) => {
        logger.warn({ err, deviceId: device.deviceId }, 'failed to emit heartbeat');
      });
    }, HEARTBEAT_INTERVAL_MS));
  }
}

export function stopAllLoops(): void {
  for (const handle of handles) {
    clearInterval(handle);
  }
  handles.length = 0;
}
