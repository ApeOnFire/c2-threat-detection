import { Redis } from 'ioredis';
import { Queue } from 'bullmq';

export const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export const queue = new Queue('detection-events', { connection });
