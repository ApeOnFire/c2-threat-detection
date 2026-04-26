---
id: ADR-001
status: Accepted
date: 2026-04-26
---

# ADR-001: Synchronous alarm path, asynchronous indexing path

## Context

Two consumers need to act on every detection event: the alarm evaluator (safety-critical, operator-visible) and the Elasticsearch indexer (audit trail, tolerates latency). Treating them identically forces a trade-off that neither optimises well.

## Decision

The alarm path is synchronous HTTP (ingestion-service → alert-engine). The indexing path is async via BullMQ (ingestion-service → Redis queue → event-store-service). They are sequentially ordered but failure-independent: a BullMQ failure after a successful alarm evaluation does not cause a retry that re-evaluates the alarm.

## Consequences

- Alarm failures are immediate and visible: ingestion-service returns 503 if alert-engine is unreachable. Silent queueing of alarm events is not possible.
- Indexing failures are isolated: Elasticsearch downtime does not affect alarm evaluation. BullMQ retries (3×, exponential backoff) handle transient ES failures.
- Any new downstream consumer of detection events must explicitly choose which path it belongs on. That choice determines the failure mode: loud and immediate (503) or silent with retry. There is no neutral option.
