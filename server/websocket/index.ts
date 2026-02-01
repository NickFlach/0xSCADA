/**
 * WebSocket Module
 * 
 * Exports WebSocket server components for real-time event streaming
 */

export { 
  EventStreamServer, 
  eventStreamServer,
  type ClientFilter,
  type ClientConnection,
  type ConnectionMetrics,
  type WebSocketMessage,
} from "./event-stream";
