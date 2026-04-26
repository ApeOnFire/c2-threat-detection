import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@vantage/types';

export const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const queue = new Queue(QUEUE_NAMES.DETECTION_EVENTS, { connection });
