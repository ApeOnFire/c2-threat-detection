import type { DetectionEvent } from '@vantage/types';
import type { AlarmRule } from './types.js';

export type EvalOutput =
  | { alarmTriggered: false }
  | { alarmTriggered: true; alarmSubtype: string };

export function evaluate(
  event: DetectionEvent,
  rules: AlarmRule[],
): EvalOutput {
  const applicable = rules.filter(
    (r) => r.event_type === event.eventType && r.enabled,
  );

  for (const rule of applicable) {
    if (matchesRule(rule, event.payload)) {
      return { alarmTriggered: true, alarmSubtype: rule.alarm_subtype };
    }
  }

  return { alarmTriggered: false };
}

function matchesRule(
  rule: AlarmRule,
  payload: DetectionEvent['payload'],
): boolean {
  const value = (payload as Record<string, unknown>)[rule.field];

  if (rule.operator === '>') {
    return (
      typeof value === 'number' &&
      rule.threshold !== null &&
      value > rule.threshold
    );
  }

  if (rule.operator === 'IS NOT NULL') {
    return value !== null && value !== undefined;
  }

  return false;
}
