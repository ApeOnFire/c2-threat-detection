import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval, switchMap, startWith } from 'rxjs';
import { ApiService } from '../../services/api.service';
import type { DeviceState } from '../../models/api.types';
import { DeviceCardComponent } from './device-card/device-card.component';
import { ActiveAlarmsComponent } from './active-alarms/active-alarms.component';

@Component({
  selector: 'app-live-operations',
  standalone: true,
  imports: [CommonModule, DeviceCardComponent, ActiveAlarmsComponent],
  templateUrl: './live-operations.component.html',
})
export class LiveOperationsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);

  devices = signal<DeviceState[]>([]);
  private sub = new Subscription();

  onlineCount = computed(() => this.devices().filter((d) => d.status === 'ONLINE').length);

  ngOnInit(): void {
    this.sub.add(
      interval(10_000)
        .pipe(startWith(0), switchMap(() => this.api.getDevices()))
        .subscribe((devices) => this.devices.set(devices)),
    );
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }
}
