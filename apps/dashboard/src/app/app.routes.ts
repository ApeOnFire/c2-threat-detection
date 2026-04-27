import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./views/live-operations/live-operations.component').then(
        (m) => m.LiveOperationsComponent,
      ),
  },
  {
    path: 'events',
    loadComponent: () =>
      import('./views/event-search/event-search.component').then(
        (m) => m.EventSearchComponent,
      ),
  },
  {
    path: 'alarms',
    loadComponent: () =>
      import('./views/alarm-history/alarm-history.component').then(
        (m) => m.AlarmHistoryComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
