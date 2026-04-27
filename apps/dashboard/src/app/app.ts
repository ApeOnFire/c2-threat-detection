import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { WebSocketService } from './services/websocket.service';
import { TestModePanelComponent } from './views/test-mode-panel/test-mode-panel.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ButtonModule,
    ToastModule,
    TestModePanelComponent,
  ],
  templateUrl: './app.html',
})
export class App implements OnInit {
  private ws = inject(WebSocketService);
  testPanelVisible = signal(false);

  ngOnInit(): void {
    this.ws.connect();
  }

  toggleTestPanel(): void {
    this.testPanelVisible.update((v) => !v);
  }
}
