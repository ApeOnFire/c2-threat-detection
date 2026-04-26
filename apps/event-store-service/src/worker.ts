import { Worker, Queue } from 'bullmq';
import { QUEUE_NAMES, type DetectionEvent } from '@vantage/types';
import { esClient, INDEX_NAME } from './elasticsearch.js';
import { jobsProcessedTotal, setQueueRef } from './metrics.js';
import { logger } from './logger.js';

export interface WorkerHandle {
  worker: Worker;
  queue: Queue;
}

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 6379,
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.username && { username: decodeURIComponent(u.username) }),
    db: u.pathname.length > 1 ? parseInt(u.pathname.slice(1), 10) : 0,
  };
}

export function startWorker(redisUrl: string): WorkerHandle {
  const queue = new Queue(QUEUE_NAMES.DETECTION_EVENTS, {
    connection: parseRedisUrl(redisUrl),
  });
  setQueueRef(queue);

  const worker = new Worker<DetectionEvent>(
    QUEUE_NAMES.DETECTION_EVENTS,
    async (job) => {
      const event = job.data;

      await esClient.index({
        index: INDEX_NAME,
        id: event.eventId,
        document: event,
      });

      jobsProcessedTotal.inc();
      logger.info(
        { eventId: event.eventId, jobId: job.id, deviceId: event.deviceId },
        'event indexed',
      );
    },
    {
      connection: parseRedisUrl(redisUrl),
      concurrency: 5,
    },
  );

  // `prev` is the previous job state string — included in signature to match BullMQ v5 types
  worker.on('failed', (job, err, prev) => {
    logger.error(
      {
        err,
        jobId: job?.id,
        eventId: job?.data?.eventId,
        attemptsMade: job?.attemptsMade,
        prev,
      },
      'job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'worker connection error');
  });

  logger.info({ queue: QUEUE_NAMES.DETECTION_EVENTS, concurrency: 5 }, 'BullMQ worker started');

  return { worker, queue };
}
