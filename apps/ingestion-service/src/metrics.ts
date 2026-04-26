import { Registry, Counter, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const ingestionEventsTotal = new Counter({
  name: 'ingestion_events_total',
  help: 'Total detection events processed by ingestion-service',
  labelNames: ['eventType', 'platformAlarmStatus'],
  registers: [registry],
});
