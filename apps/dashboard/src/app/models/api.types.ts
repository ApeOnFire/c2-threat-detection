export interface DeviceState {
  deviceId: string;
  deviceType: string;
  lastSeen: string | null;
  backgroundCountRate: number | null;
  status: 'ONLINE' | 'OFFLINE';
}

export interface Alarm {
  id: string;
  deviceId: string;
  siteId: string;
  eventType: string;
  alarmSubtype: string;
  peakCountRate: number | null;
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggeredAt: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface DetectionEvent {
  eventId: string;
  deviceId: string;
  deviceType: string;
  siteId: string;
  timestamp: string;
  vendorId: string;
  eventType: string;
  platformAlarmStatus: 'CLEAR' | 'ALARM';
  payload: {
    type: string;
    peakCountRate?: number;
    backgroundCountRate?: number;
    isotope?: string | null;
    detectorAlarmSubtype?: string | null;
    durationMs?: number;
    [key: string]: unknown;
  };
}

export interface AlarmsResponse {
  total: number;
  alarms: Alarm[];
}

export interface EventsResponse {
  total: number;
  events: DetectionEvent[];
}

export interface WsMessage {
  type: 'alarm';
  alarm: Alarm;
}
