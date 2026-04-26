---
id: ADR-003
status: Accepted
date: 2026-04-26
---

# ADR-003: PostgreSQL LISTEN/NOTIFY for alarm rule hot-reload, with a dedicated client

## Context

Alarm rules are operator-configurable. A service restart to pick up rule changes is unacceptable in a live C2 environment. Polling the `alarm_rules` table on a timer adds unnecessary load and introduces a detection lag proportional to the poll interval.

## Decision

alert-engine subscribes to a `LISTEN alarm_rules_updated` channel on startup. A PostgreSQL trigger fires `pg_notify` on any `INSERT`, `UPDATE`, or `DELETE` on `alarm_rules`. alert-engine re-queries the table on notification and replaces the in-memory cache atomically.

The LISTEN subscription uses a dedicated `pg.Client`, not a connection from the pool. Pool connections are recycled between queries; returning a connection silently drops its `LISTEN` subscription without error.

## Consequences

- Rule changes are reflected within ~1 second with no service restart.
- The dedicated client must be monitored: an unrecoverable connection error exits the process (K8s restarts it), which is preferable to silently serving stale rules. This is the inverse of the BullMQ worker pattern — a dropped worker Redis connection is recoverable via ioredis reconnect with no state loss, so the worker does not exit. A dropped LISTEN connection leaves the rule cache stale with no recovery path short of restart.
