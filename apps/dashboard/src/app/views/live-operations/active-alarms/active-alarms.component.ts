import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { trigger, transition, style, animate } from '@angular/animations';
import { Subscription } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../../services/api.service';
import { WebSocketService } from '../../../services/websocket.service';
import { AlarmLabelPipe } from '../../../pipes/alarm-label.pipe';
import type { Alarm } from '../../../models/api.types';

@Component({
  selector: 'app-active-alarms',
  standalone: true,
  imports: [CommonModule, ButtonModule, TableModule, AlarmLabelPipe],
  templateUrl: './active-alarms.component.html',
  animations: [
    trigger('slideIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(-12px)' }),
        animate('250ms ease-out', style({ opacity: 1, transform: 'translateY(0)' })),
      ]),
    ]),
  ],
})
export class ActiveAlarmsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private ws = inject(WebSocketService);
  private toast = inject(MessageService);

  alarms = signal<Alarm[]>([]);
  acknowledging = signal<Set<string>>(new Set());
  private sub = new Subscription();

  ngOnInit(): void {
    this.api.getAlarms({ status: 'ACTIVE', limit: 20 }).subscribe({
      next: (res) => { this.alarms.set(res.alarms); },
      error: () => {
        this.toast.add({ severity: 'error', summary: 'Load failed', detail: 'Could not load active alarms', life: 5000 });
      },
    });

    this.sub.add(
      this.ws.messages().subscribe((msg) => {
        if (msg.type === 'alarm' && msg.alarm.status === 'ACTIVE') {
          this.alarms.update((prev) =>
            [msg.alarm, ...prev.filter((a) => a.id !== msg.alarm.id)].slice(0, 20),
          );
        }
      }),
    );
  }

  acknowledge(alarm: Alarm): void {
    this.acknowledging.update((s) => new Set([...s, alarm.id]));
    this.api.acknowledgeAlarm(alarm.id).subscribe({
      next: () => {
        this.alarms.update((prev) => prev.filter((a) => a.id !== alarm.id));
        this.acknowledging.update((s) => { const n = new Set(s); n.delete(alarm.id); return n; });
      },
      error: () => {
        this.acknowledging.update((s) => { const n = new Set(s); n.delete(alarm.id); return n; });
      },
    });
  }

  isAcknowledging(id: string): boolean {
    return this.acknowledging().has(id);
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
