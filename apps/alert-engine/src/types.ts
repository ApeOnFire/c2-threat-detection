export interface AlarmRule {
  id: string;
  event_type: string;
  field: string;
  operator: string;
  threshold: number | null;
  alarm_subtype: string;
  enabled: boolean;
}
