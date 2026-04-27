import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'alarmLabel', standalone: true })
export class AlarmLabelPipe implements PipeTransform {
  transform(value: string): string {
    const labels: Record<string, string> = {
      NORM_THRESHOLD: 'NORM Threshold',
      ISOTOPE_IDENTIFIED: 'Isotope ID',
    };
    return labels[value] ?? value;
  }
}
