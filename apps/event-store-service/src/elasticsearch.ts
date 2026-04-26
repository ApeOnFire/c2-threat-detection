import { Client, errors } from '@elastic/elasticsearch';
import { logger } from './logger.js';

export const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
});

export const INDEX_NAME = 'detection-events';

export async function bootstrapIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: INDEX_NAME });

  if (exists) {
    logger.info({ index: INDEX_NAME }, 'ES index already exists — skipping creation');
    return;
  }

  try {
    await esClient.indices.create({
      index: INDEX_NAME,
      mappings: {
        properties: {
          eventId:             { type: 'keyword' },
          deviceId:            { type: 'keyword' },
          deviceType:          { type: 'keyword' },
          siteId:              { type: 'keyword' },
          timestamp:           { type: 'date' },
          vendorId:            { type: 'keyword' },
          eventType:           { type: 'keyword' },
          platformAlarmStatus: { type: 'keyword' },
          payload: {
            type: 'object',
            properties: {
              type:                 { type: 'keyword' },
              durationMs:           { type: 'integer' },
              peakCountRate:        { type: 'float' },
              backgroundCountRate:  { type: 'float' },
              isotope:              { type: 'keyword' },
              detectorAlarmSubtype: { type: 'keyword' },
            },
          },
        },
      },
    });
    logger.info({ index: INDEX_NAME }, 'ES index created with explicit mapping');
  } catch (err) {
    // Two instances starting simultaneously — second create loses the race; safe to ignore.
    if (err instanceof errors.ResponseError && err.statusCode === 400) {
      logger.info({ index: INDEX_NAME }, 'ES index creation race — already exists');
      return;
    }
    throw err;
  }
}
