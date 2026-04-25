// Envelope — common across all device types and vendors
export interface DetectionEvent {
  eventId: string;
  deviceId: string;
  deviceType: string;
  siteId: string;
  timestamp: string;          // ISO8601
  vendorId: string;
  eventType: 'RADIATION_SCAN' | 'XRAY_SCAN' | 'CBRN_DETECTION';
  // Set by ingestion-service from alert-engine's evaluation result — not by the device.
  // Simulator always sends 'CLEAR' as a placeholder; ingestion-service unconditionally
  // overwrites this with the platform's verdict before enqueuing to BullMQ.
  platformAlarmStatus: 'CLEAR' | 'ALARM';
  payload: RadiationPayload | XrayPayload | CbrnPayload;
}

// Radiation-specific payload — the only type implemented in this demo
export interface RadiationPayload {
  type: 'RADIATION_SCAN';
  durationMs: number;
  peakCountRate: number;
  backgroundCountRate: number;
  isotope: string | null;
  // The detector's own alarm classification — set by the simulator based on simulated scan data.
  // Distinct from alert-engine's alarmSubtype (which is the platform's rule evaluation result).
  // null = detector did not identify an alarm condition in the raw scan data.
  detectorAlarmSubtype: 'NORM_THRESHOLD' | 'ISOTOPE_IDENTIFIED' | null;
}

// Stub types — not implemented; present to make the envelope pattern legible
export interface XrayPayload {
  type: 'XRAY_SCAN';
  [key: string]: unknown;
}

export interface CbrnPayload {
  type: 'CBRN_DETECTION';
  [key: string]: unknown;
}

// Heartbeat — device liveness signal, not stored in Elasticsearch
// deviceType is included so the Redis device state is self-describing.
// In real deployments the device communicates its type on connection; including it
// in the heartbeat mirrors that pattern without requiring a separate registration step.
export interface Heartbeat {
  deviceId: string;
  deviceType: string;
  timestamp: string;         // ISO8601
  backgroundCountRate: number;
  status: 'ONLINE';
}

// Shape returned by alert-engine POST /evaluate
export interface EvaluateResult {
  alarmTriggered: boolean;
  alarmId?: string;
  alarmSubtype?: string;  // string, not a literal union — new modalities add new subtypes
}

// Shape returned by GET /api/devices
export interface DeviceState {
  deviceId: string;
  deviceType: string;
  lastSeen: string;          // ISO8601
  backgroundCountRate: number;
  status: 'ONLINE' | 'OFFLINE';
}

// Alarm record as stored in PostgreSQL and returned by GET /api/alarms
export interface Alarm {
  id: string;
  deviceId: string;
  siteId: string;
  eventType: string;
  alarmSubtype: string;
  peakCountRate: number | null;
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggeredAt: string;       // ISO8601
  acknowledgedAt: string | null;
  createdAt: string;         // ISO8601
}
