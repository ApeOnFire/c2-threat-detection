import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';
import type { DetectionEvent } from '../../models/api.types';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-event-search',
  standalone: true,
  imports: [CommonModule, FormsModule, InputTextModule, SelectModule, DatePickerModule, ButtonModule, TableModule, TagModule],
  templateUrl: './event-search.component.html',
})
export class EventSearchComponent implements OnInit {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  q = signal('');
  deviceId = signal('');
  eventType = signal('');
  dateRange = signal<Date[] | null>(null);

  events = signal<DetectionEvent[]>([]);
  total = signal(0);
  loading = signal(false);
  page = signal(0);

  deviceOptions = signal([{ label: 'All Devices', value: '' }]);

  eventTypeOptions = [
    { label: 'All Types', value: '' },
    { label: 'Radiation Scan', value: 'RADIATION_SCAN' },
    { label: 'X-Ray Scan', value: 'XRAY_SCAN' },
    { label: 'CBRN Detection', value: 'CBRN_DETECTION' },
  ];

  ngOnInit(): void {
    this.api.getDevices().subscribe((devices) => {
      this.deviceOptions.set([
        { label: 'All Devices', value: '' },
        ...devices.map((d) => ({ label: d.deviceId, value: d.deviceId })),
      ]);
    });
  }

  search(resetPage = true): void {
    if (resetPage) this.page.set(0);
    const range = this.dateRange();
    this.loading.set(true);
    this.api.searchEvents({
      q: this.q() || undefined,
      deviceId: this.deviceId() || undefined,
      eventType: this.eventType() || undefined,
      from: range?.[0]?.toISOString(),
      to: range?.[1]?.toISOString(),
      limit: PAGE_SIZE,
      offset: this.page() * PAGE_SIZE,
    }).subscribe({
      next: (res) => { this.events.set(res.events); this.total.set(res.total); this.loading.set(false); },
      error: () => {
        this.loading.set(false);
        this.toast.add({ severity: 'error', summary: 'Search failed', detail: 'Could not reach api-service', life: 5000 });
      },
    });
  }

  onPageChange(event: { first: number }): void {
    this.page.set(event.first / PAGE_SIZE);
    this.search(false);
  }

  clear(): void {
    this.q.set(''); this.deviceId.set(''); this.eventType.set(''); this.dateRange.set(null);
    this.events.set([]); this.total.set(0);
  }

  pageSize = PAGE_SIZE;
}
