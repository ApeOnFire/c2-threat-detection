import type { FastifyInstance } from 'fastify';
import { estypes } from '@elastic/elasticsearch';
import type { DetectionEvent } from '@vantage/types';
import { esClient } from '../elasticsearch.js';

type QueryDslQueryContainer = estypes.QueryDslQueryContainer;

interface SearchQuery {
  q?: string;
  from?: string;  // date range start (ISO8601)
  to?: string;    // date range end (ISO8601)
  deviceId?: string;
  eventType?: string;
  limit?: string;
  offset?: string;
}

export async function eventsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: SearchQuery }>(
    '/api/events/search',
    async (request) => {
      const { q, from, to, deviceId, eventType } = request.query;
      const sizeRaw = Number(request.query.limit ?? 50);
      const size = Math.min(Math.max(Number.isNaN(sizeRaw) ? 50 : sizeRaw, 0), 200);
      const esOffsetRaw = Number(request.query.offset ?? 0);
      const esOffset = Math.max(Number.isNaN(esOffsetRaw) ? 0 : esOffsetRaw, 0);

      const must: QueryDslQueryContainer[] = [];
      const filter: QueryDslQueryContainer[] = [];

      if (q) {
        // Wildcard contains-match with case_insensitive: true on each keyword field.
        // multi_match on keyword fields is exact-match only — 'PM' would not match 'PM-01'.
        // Wrapping user input as *q* gives contains semantics; case_insensitive covers
        // operators typing 'alarm' vs 'ALARM'.
        const searchFields = [
          'deviceId',
          'siteId',
          'eventType',
          'platformAlarmStatus',
          'payload.isotope',
          'payload.detectorAlarmSubtype',
        ];
        must.push({
          bool: {
            should: searchFields.map((field) => ({
              wildcard: { [field]: { value: `*${q}*`, case_insensitive: true } },
            })),
            minimum_should_match: 1,
          },
        });
      }

      if (from || to) {
        const range: { gte?: string; lte?: string } = {};
        if (from) range.gte = from;
        if (to) range.lte = to;
        filter.push({ range: { timestamp: range } });
      }

      if (deviceId) filter.push({ term: { deviceId: { value: deviceId } } });
      if (eventType) filter.push({ term: { eventType: { value: eventType } } });

      const esQuery: QueryDslQueryContainer =
        must.length === 0 && filter.length === 0
          ? { match_all: {} }
          : {
              bool: {
                ...(must.length ? { must } : {}),
                ...(filter.length ? { filter } : {}),
              },
            };

      const result = await esClient.search<DetectionEvent>({
        index: 'detection-events',
        from: esOffset,
        size,
        sort: [{ timestamp: { order: 'desc' as const } }],
        query: esQuery,
      });

      const total =
        typeof result.hits.total === 'object'
          ? result.hits.total.value
          : (result.hits.total ?? 0);

      return {
        total,
        events: result.hits.hits.map((hit) => hit._source),
      };
    },
  );
}
