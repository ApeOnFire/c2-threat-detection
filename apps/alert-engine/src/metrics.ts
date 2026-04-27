import { Registry, Histogram, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const evaluateDurationSeconds = new Histogram({
  name: 'alert_engine_evaluate_duration_seconds',
  help: 'End-to-end latency of POST /evaluate (rule eval + DB write)',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

export const alarmsTriggeredTotal = new Counter({
  name: 'alert_engine_alarms_triggered_total',
  help: 'Total new alarms written to PostgreSQL, by subtype',
  labelNames: ['alarmSubtype'],
  registers: [registry],
});
