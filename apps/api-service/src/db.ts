import { Pool } from 'pg';
import type { Alarm } from '@vantage/types';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// pg returns column names in snake_case and NUMERIC columns as strings.
export interface AlarmRow {
  id: string;
  device_id: string;
  site_id: string;
  event_type: string;
  alarm_subtype: string;
  peak_count_rate: string | null; // NUMERIC → string from pg; coerce with Number()
  isotope: string | null;
  status: 'ACTIVE' | 'ACKNOWLEDGED';
  triggered_at: Date;
  acknowledged_at: Date | null;
  created_at: Date;
}

export function mapAlarmRow(row: AlarmRow): Alarm {
  return {
    id: row.id,
    deviceId: row.device_id,
    siteId: row.site_id,
    eventType: row.event_type,
    alarmSubtype: row.alarm_subtype,
    peakCountRate: row.peak_count_rate !== null ? Number(row.peak_count_rate) : null,
    isotope: row.isotope,
    status: row.status,
    triggeredAt: row.triggered_at.toISOString(),
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
