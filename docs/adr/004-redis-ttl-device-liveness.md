---
id: ADR-004
status: Accepted
date: 2026-04-26
---

# ADR-004: Redis TTL expiry as device offline signal

## Context

The operator dashboard must reflect whether each device is actively communicating. Devices do not send an explicit disconnect message — a lost network connection, powered-off device, or crashed simulator simply stops sending.

## Decision

Each heartbeat writes a Redis hash (`device:state:{deviceId}`) with a 30-second TTL. No explicit "go offline" message exists. api-service infers `status: OFFLINE` for any device whose key is absent.

The 30-second TTL was chosen to be longer than the 5-second heartbeat interval (tolerates up to ~5 missed heartbeats) but short enough to surface a genuine failure within a tactically relevant window.

## Consequences

- No protocol change is needed to detect device failure — expiry handles it automatically.
- A 30-second offline detection lag is acceptable for this use case. Tighter TTLs risk false positives from transient network blips.
- If ingestion-service restarts, Redis keys expire naturally; device status self-heals when heartbeats resume.
