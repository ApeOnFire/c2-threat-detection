import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import { AlarmLabelPipe } from '../../pipes/alarm-label.pipe';
import type { Alarm } from '../../models/api.types';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-alarm-history',
  standalone: true,
  imports: [CommonModule, FormsModule, SelectModule, DatePickerModule, ButtonModule, TableModule, AlarmLabelPipe],
  templateUrl: './alarm-history.component.html',
})
export class AlarmHistoryComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  status = signal<'ACTIVE' | 'ACKNOWLEDGED' | ''>('');
  deviceId = signal('');
  alarmSubtype = signal('');
  dateRange = signal<Date[] | null>(null);

  alarms = signal<Alarm[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(0);

  statusOptions = [
    { label: 'All', value: '' },
    { label: 'Active', value: 'ACTIVE' },
    { label: 'Acknowledged', value: 'ACKNOWLEDGED' },
  ];

  deviceOptions = signal([{ label: 'All', value: '' }]);

  subtypeOptions = [
    { label: 'All', value: '' },
    { label: 'NORM Threshold', value: 'NORM_THRESHOLD' },
    { label: 'Isotope ID', value: 'ISOTOPE_IDENTIFIED' },
  ];

  pageSize = PAGE_SIZE;

  ngOnInit(): void {
    this.load();
    this.api.getDevices().subscribe((devices) => {
      this.deviceOptions.set([
        { label: 'All', value: '' },
        ...devices.map((d) => ({ label: d.deviceId, value: d.deviceId })),
      ]);
    });
  }

  clear(): void {
    this.status.set('');
    this.deviceId.set('');
    this.alarmSubtype.set('');
    this.dateRange.set(null);
    this.load();
  }

  load(resetPage = true): void {
    const range = this.dateRange();
    // PrimeNG fires ngModelChange after first date selection with range[1] = null — wait for both dates.
    if (range && !range[1]) return;
    if (resetPage) this.page.set(0);
    this.loading.set(true);
    this.api.getAlarms({
      status: (this.status() as 'ACTIVE' | 'ACKNOWLEDGED') || undefined,
      deviceId: this.deviceId() || undefined,
      alarmSubtype: this.alarmSubtype() || undefined,
      from: range?.[0]?.toISOString(),
      to: range?.[1]?.toISOString(),
      limit: PAGE_SIZE,
      offset: this.page() * PAGE_SIZE,
    }).subscribe({
      next: (res) => { this.alarms.set(res.alarms); this.total.set(res.total); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Load failed', detail: 'Could not load alarm history', life: 5000 });
      },
    });
  }

  onPageChange(event: { first: number }): void {
    this.page.set(event.first / PAGE_SIZE);
    this.load(false);
  }
}
