import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { logger } from './logger.js';

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    if (req.url !== '/ws') {
      ws.close(1008, 'Invalid path');
      return;
    }

    clients.add(ws);
    logger.info({ clientCount: clients.size }, 'ws client connected');

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ clientCount: clients.size }, 'ws client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'ws client error');
      clients.delete(ws);
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'ws server error');
  });

  logger.info('WebSocket server initialised on /ws');
}

export function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      sent++;
    }
  }
  logger.info({ clientCount: clients.size, sent }, 'alarm broadcast');
}

export function closeWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) {
      resolve();
      return;
    }
    // Terminate all clients immediately — wss.close() callback only fires once
    // every existing connection has closed. Without this, a connected dashboard
    // or wscat session keeps the promise pending until K8s sends SIGKILL.
    for (const client of clients) {
      client.terminate();
    }
    wss.close(() => resolve());
  });
}
