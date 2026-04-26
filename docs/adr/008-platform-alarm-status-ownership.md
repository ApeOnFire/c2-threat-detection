---
id: ADR-008
status: Accepted
date: 2026-04-26
---

# ADR-008: platformAlarmStatus is set exclusively by ingestion-service

## Context

`DetectionEvent` carries a `platformAlarmStatus` field (`CLEAR` | `ALARM`) that downstream services (event-store, api-service) use for filtering and display. Devices could set this themselves based on their own hardware thresholds, but device-reported alarm status and platform rule evaluation may diverge — especially for third-party sensors with different sensitivity calibrations.

## Decision

The simulator always sends `platformAlarmStatus: 'CLEAR'` as a placeholder. ingestion-service unconditionally overwrites this field with the result returned by alert-engine before enqueuing the event. No downstream service reads the device-supplied value.

`detectorAlarmSubtype` in `RadiationPayload` is a separate field representing the hardware's own classification and is deliberately preserved unchanged. The two fields are distinct: one is the device's verdict, the other is the platform's.

## Consequences

- The platform's rule evaluation is always the authoritative source for alarm status in stored events, regardless of what the device reported.
- Third-party devices with their own alarm logic can be ingested without their self-reported alarm status polluting the platform record.
