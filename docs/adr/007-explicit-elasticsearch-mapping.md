---
id: ADR-007
status: Accepted
date: 2026-04-26
---

# ADR-007: Explicit Elasticsearch index mapping defined on startup

## Context

Elasticsearch's dynamic mapping infers field types from the first document indexed. For string fields like `deviceId`, `eventType`, `alarmStatus`, and `siteId`, it infers `text` (full-text analysed) rather than `keyword`. Term filter queries — the primary query pattern for the Detection Event Search view — silently return no results against `text` fields.

## Decision

event-store-service creates the `detection-events` index with an explicit mapping on startup if it does not already exist. `deviceId`, `eventType`, `alarmStatus`, and `siteId` are mapped as `keyword`. `timestamp` is mapped as `date`. `peakCountRate` and `backgroundCountRate` are mapped as `float`. The `payload` object is mapped as `nested`.

## Consequences

- Term filter queries on all categorical fields work correctly from the first indexed document.
- Any field added to `DetectionEvent` that operators will filter or aggregate must have its type explicitly declared in the mapping before documents are indexed. Adding it after the fact requires a mapping update and full index reindex — Elasticsearch provides no automatic migration path.
