import type { AlarmRule } from './types.js';

let cache: AlarmRule[] = [];

export function getRules(): AlarmRule[] {
  return cache;
}

export function setRules(rules: AlarmRule[]): void {
  cache = rules;
}
