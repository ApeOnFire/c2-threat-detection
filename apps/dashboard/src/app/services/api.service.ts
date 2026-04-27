import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Alarm, AlarmsResponse, DeviceState, EventsResponse } from '../models/api.types';

export interface AlarmsParams {
  status?: 'ACTIVE' | 'ACKNOWLEDGED';
  deviceId?: string;
  alarmSubtype?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface EventsParams {
  q?: string;
  from?: string;
  to?: string;
  deviceId?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  getDevices(): Observable<DeviceState[]> {
    return this.http.get<DeviceState[]>('/api/devices');
  }

  getAlarms(params: AlarmsParams = {}): Observable<AlarmsResponse> {
    let p = new HttpParams();
    if (params.status) p = p.set('status', params.status);
    if (params.deviceId) p = p.set('deviceId', params.deviceId);
    if (params.alarmSubtype) p = p.set('alarmSubtype', params.alarmSubtype);
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    if (params.limit != null) p = p.set('limit', params.limit);
    if (params.offset != null) p = p.set('offset', params.offset);
    return this.http.get<AlarmsResponse>('/api/alarms', { params: p });
  }

  acknowledgeAlarm(id: string): Observable<Alarm> {
    return this.http.patch<Alarm>(`/api/alarms/${id}/acknowledge`, {});
  }

  searchEvents(params: EventsParams = {}): Observable<EventsResponse> {
    let p = new HttpParams();
    if (params.q) p = p.set('q', params.q);
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    if (params.deviceId) p = p.set('deviceId', params.deviceId);
    if (params.eventType) p = p.set('eventType', params.eventType);
    if (params.limit != null) p = p.set('limit', params.limit);
    if (params.offset != null) p = p.set('offset', params.offset);
    return this.http.get<EventsResponse>('/api/events/search', { params: p });
  }

  triggerScenario(name: string): Observable<{ ok: boolean; scenario: string }> {
    return this.http.post<{ ok: boolean; scenario: string }>(`/api/scenarios/${name}`, {});
  }
}
