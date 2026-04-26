---
id: ADR-002
status: Accepted
date: 2026-04-26
---

# ADR-002: Layered event idempotency across three stores

## Context

A network failure between alert-engine's PostgreSQL write and its HTTP response to ingestion-service causes ingestion-service to return 503 and the device to retry. Without idempotency, each retry produces duplicate alarm records, duplicate queue jobs, and duplicate Elasticsearch documents.

## Decision

Each persistence layer independently deduplicates on `eventId`:

| Layer | Mechanism |
|---|---|
| PostgreSQL | `event_id TEXT UNIQUE NOT NULL` + `ON CONFLICT (event_id) DO NOTHING` in an explicit transaction |
| BullMQ | `{ jobId: eventId }` on `queue.add` — duplicate job is a no-op while the original is in-flight |
| Elasticsearch | `eventId` as the document `_id` — BullMQ retries are safe overwrites |

## Consequences

- Each layer covers a different failure window: PG covers the alarm write, BullMQ covers the enqueue, ES covers the indexing step. A retry anywhere in the chain produces no duplicates and requires no operator intervention.
- BullMQ job deduplication is ephemeral — it only prevents duplicates while the original job is still in the queue. ES `_id` deduplication covers retries that arrive after the job has already been consumed. The two mechanisms are complementary, not redundant.
- Any new persistence step added to the pipeline requires its own idempotency mechanism. The pattern must be extended, not assumed.
