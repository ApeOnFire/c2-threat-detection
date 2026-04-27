import crypto from 'node:crypto';
import type { DetectionEvent, RadiationPayload } from '@vantage/types';
import { DEVICES, SITE_ID, VENDOR_ID } from './devices.js';
import { emitEvent } from './emit.js';
import { suppressHeartbeatsFor } from './loops.js';

export class UnknownScenarioError extends Error {
  constructor(name: string) {
    super(`Unknown scenario: ${name}`);
    this.name = 'UnknownScenarioError';
  }
}

interface AlarmEventSpec {
  deviceId: string;
  peakCountRate: number;
  isotope: string | null;
  detectorAlarmSubtype: 'NORM_THRESHOLD' | 'ISOTOPE_IDENTIFIED';
}

function buildAlarmEvent(spec: AlarmEventSpec): DetectionEvent {
  const device = DEVICES.find((d) => d.deviceId === spec.deviceId);
  if (!device) throw new Error(`Unknown deviceId: ${spec.deviceId}`);

  const payload: RadiationPayload = {
    type: 'RADIATION_SCAN',
    durationMs: 2000,
    peakCountRate: spec.peakCountRate,
    backgroundCountRate: 45,
    isotope: spec.isotope,
    detectorAlarmSubtype: spec.detectorAlarmSubtype,
  };

  return {
    eventId: crypto.randomUUID(),
    deviceId: device.deviceId,
    deviceType: device.deviceType,
    siteId: SITE_ID,
    timestamp: new Date().toISOString(),
    vendorId: VENDOR_ID,
    eventType: 'RADIATION_SCAN',
    platformAlarmStatus: 'CLEAR',
    payload,
  };
}

export async function runScenario(name: string): Promise<void> {
  switch (name) {
    case 'norm-threshold':
      await emitEvent(
        buildAlarmEvent({
          deviceId: 'PM-01',
          peakCountRate: 320,
          isotope: null,
          detectorAlarmSubtype: 'NORM_THRESHOLD',
        }),
      );
      break;

    case 'isotope-identified':
      await emitEvent(
        buildAlarmEvent({
          deviceId: 'PM-02',
          peakCountRate: 180,
          isotope: 'Cs-137',
          detectorAlarmSubtype: 'ISOTOPE_IDENTIFIED',
        }),
      );
      break;

    case 'concurrent':
      await Promise.all([
        emitEvent(
          buildAlarmEvent({
            deviceId: 'PM-01',
            peakCountRate: 320,
            isotope: null,
            detectorAlarmSubtype: 'NORM_THRESHOLD',
          }),
        ),
        emitEvent(
          buildAlarmEvent({
            deviceId: 'PM-02',
            peakCountRate: 180,
            isotope: 'Cs-137',
            detectorAlarmSubtype: 'ISOTOPE_IDENTIFIED',
          }),
        ),
      ]);
      break;

    case 'device-offline':
      // Suppress PM-01 heartbeats for 45 s — Redis TTL is 30 s, so the device
      // will appear OFFLINE within ~35 s and recover automatically after 45 s.
      suppressHeartbeatsFor('PM-01', 45_000);
      break;

    default:
      throw new UnknownScenarioError(name);
  }
}
