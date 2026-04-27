import { Component, inject, signal, model } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DrawerModule } from 'primeng/drawer';
import { ButtonModule } from 'primeng/button';
import { MessageService } from 'primeng/api';
import { ApiService } from '../../services/api.service';

interface Scenario {
  name: string;
  label: string;
  description: string;
  severity: 'warn' | 'danger' | 'info';
}

@Component({
  selector: 'app-test-mode-panel',
  standalone: true,
  imports: [CommonModule, DrawerModule, ButtonModule],
  templateUrl: './test-mode-panel.component.html',
})
export class TestModePanelComponent {
  private api = inject(ApiService);
  private toast = inject(MessageService);

  visible = model<boolean>(false);
  loading = signal<Record<string, boolean>>({});

  scenarios: Scenario[] = [
    {
      name: 'norm-threshold',
      label: 'NORM Threshold Exceedance',
      description: 'PM-01 · 320 cps — exceeds background threshold',
      severity: 'warn',
    },
    {
      name: 'isotope-identified',
      label: 'Isotope Identification',
      description: 'PM-02 · Cs-137 identified · 180 cps',
      severity: 'danger',
    },
    {
      name: 'concurrent',
      label: 'Concurrent Alarms',
      description: 'PM-01 + PM-02 simultaneously',
      severity: 'danger',
    },
    {
      name: 'device-offline',
      label: 'Device Goes Offline',
      description: 'PM-01 · heartbeats suppressed for 45 s — appears OFFLINE within ~35 s, then recovers',
      severity: 'warn',
    },
  ];

  trigger(scenario: Scenario): void {
    this.loading.update((s) => ({ ...s, [scenario.name]: true }));
    this.api.triggerScenario(scenario.name).subscribe({
      next: () => {
        this.loading.update((s) => ({ ...s, [scenario.name]: false }));
        this.toast.add({ severity: 'success', summary: 'Scenario triggered', detail: scenario.label, life: 3000 });
      },
      error: () => {
        this.loading.update((s) => ({ ...s, [scenario.name]: false }));
        this.toast.add({ severity: 'error', summary: 'Scenario failed', detail: 'Check that all services are running', life: 4000 });
      },
    });
  }

  isLoading(name: string): boolean {
    return !!this.loading()[name];
  }
}
