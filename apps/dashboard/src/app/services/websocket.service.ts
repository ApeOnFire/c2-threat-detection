import { Injectable, OnDestroy } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import type { WsMessage } from '../models/api.types';

@Injectable({ providedIn: 'root' })
export class WebSocketService implements OnDestroy {
  private ws: WebSocket | null = null;
  private message$ = new Subject<WsMessage>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as WsMessage;
        this.message$.next(msg);
      } catch {
        // malformed message — ignore
      }
    };

    this.ws.onclose = () => {
      if (this.shouldReconnect) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  messages(): Observable<WsMessage> {
    return this.message$.asObservable();
  }

  ngOnDestroy(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
