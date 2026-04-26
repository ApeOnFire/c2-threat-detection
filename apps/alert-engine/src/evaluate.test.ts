import { describe, it, expect } from 'vitest';
import { evaluate } from './evaluate.js';
import type { DetectionEvent } from '@vantage/types';
import type { AlarmRule } from './types.js';

const normRule: AlarmRule = {
  id: '00000000-0000-0000-0000-000000000001',
  event_type: 'RADIATION_SCAN',
  field: 'peakCountRate',
  operator: '>',
  threshold: 250,
  alarm_subtype: 'NORM_THRESHOLD',
  enabled: true,
};

const isotopeRule: AlarmRule = {
  id: '00000000-0000-0000-0000-000000000002',
  event_type: 'RADIATION_SCAN',
  field: 'isotope',
  operator: 'IS NOT NULL',
  threshold: null,
  alarm_subtype: 'ISOTOPE_IDENTIFIED',
  enabled: true,
};

const allRules = [normRule, isotopeRule];

function makeEvent(overrides: {
  eventType?: DetectionEvent['eventType'];
  peakCountRate?: number;
  isotope?: string | null;
}): DetectionEvent {
  const {
    eventType = 'RADIATION_SCAN',
    peakCountRate = 100,
    isotope = null,
  } = overrides;

  return {
    eventId: 'test-id',
    deviceId: 'PM-01',
    deviceType: 'PORTAL_MONITOR',
    siteId: 'POE-ALPHA',
    timestamp: new Date().toISOString(),
    vendorId: 'VANTAGE',
    eventType,
    platformAlarmStatus: 'CLEAR',
    payload: {
      type: 'RADIATION_SCAN',
      durationMs: 1000,
      peakCountRate,
      backgroundCountRate: 45,
      isotope,
      detectorAlarmSubtype: null,
    },
  };
}

describe('evaluate()', () => {
  it('triggers NORM_THRESHOLD when peakCountRate > 250', () => {
    expect(evaluate(makeEvent({ peakCountRate: 320 }), allRules)).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'NORM_THRESHOLD',
    });
  });

  it('clears when peakCountRate <= 250', () => {
    expect(evaluate(makeEvent({ peakCountRate: 100 }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('triggers ISOTOPE_IDENTIFIED when isotope is not null', () => {
    expect(evaluate(makeEvent({ isotope: 'Cs-137' }), allRules)).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'ISOTOPE_IDENTIFIED',
    });
  });

  it('clears when isotope is null', () => {
    expect(evaluate(makeEvent({ isotope: null }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('does not trigger for XRAY_SCAN against radiation-scoped rules', () => {
    expect(evaluate(makeEvent({ eventType: 'XRAY_SCAN' }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });

  it('first matching rule wins — returns NORM_THRESHOLD, not ISOTOPE_IDENTIFIED, when both would match', () => {
    expect(
      evaluate(makeEvent({ peakCountRate: 320, isotope: 'Cs-137' }), allRules),
    ).toEqual({
      alarmTriggered: true,
      alarmSubtype: 'NORM_THRESHOLD',
    });
  });

  it('does not trigger at the threshold boundary (peakCountRate === 250, rule is strictly >)', () => {
    expect(evaluate(makeEvent({ peakCountRate: 250 }), allRules)).toEqual({
      alarmTriggered: false,
    });
  });
});
