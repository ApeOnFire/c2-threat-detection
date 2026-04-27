import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import type { DeviceState } from '../../../models/api.types';

@Component({
  selector: 'app-device-card',
  standalone: true,
  imports: [CommonModule, CardModule],
  templateUrl: './device-card.component.html',
})
export class DeviceCardComponent {
  device = input.required<DeviceState>();
}
