---
id: ADR-005
status: Accepted
date: 2026-04-26
---

# ADR-005: Best-effort alarm notification from alert-engine to api-service

## Context

After writing an alarm record to PostgreSQL, alert-engine notifies api-service so it can push the alarm to connected WebSocket clients. api-service does not exist until Phase 6; even when it does, its availability must not be a precondition for alarm correctness.

## Decision

The HTTP POST from alert-engine to `api-service POST /internal/alarms/notify` is fire-and-forget with a 2-second timeout. alert-engine logs a warning on failure and returns the alarm result to ingestion-service regardless. The alarm is durable in PostgreSQL before the notification is attempted.

## Consequences

- Alarm correctness is never coupled to WebSocket push availability. api-service failures, restarts, or absence during early phases do not affect alarm recording.
- Operators may miss a real-time push notification during an api-service outage, but will see the alarm on next page load (queried from PostgreSQL).
