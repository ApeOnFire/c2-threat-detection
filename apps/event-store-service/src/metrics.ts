import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Queue } from 'bullmq';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const jobsProcessedTotal = new Counter({
  name: 'event_store_jobs_processed_total',
  help: 'Total detection events successfully indexed to Elasticsearch',
  registers: [registry],
});

let _queue: Queue | null = null;

export function setQueueRef(queue: Queue): void {
  _queue = queue;
}

new Gauge({
  name: 'bullmq_queue_depth',
  help: 'Number of waiting + active jobs in the detection-events queue',
  registers: [registry],
  async collect() {
    if (!_queue) return;
    const [waiting, active] = await Promise.all([
      _queue.getWaitingCount(),
      _queue.getActiveCount(),
    ]);
    this.set(waiting + active);
  },
});
