// WebSocket server barrel export
export * from './types';

let wsServer: any = null;

export function getWebSocketServer() {
  return wsServer;
}

export function setWebSocketServer(server: any) {
  wsServer = server;
}
