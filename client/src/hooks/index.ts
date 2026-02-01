/**
 * Hooks Module
 * 
 * Central export for all custom hooks
 */

export { useMobile, useIsMobile } from "./use-mobile";
export { useToast, toast } from "./use-toast";
export { 
  useWebSocket, 
  type ConnectionStatus, 
  type WebSocketMessage, 
  type UseWebSocketOptions, 
  type UseWebSocketReturn 
} from "./use-websocket";
export { 
  useEventStream, 
  type StreamEvent, 
  type EventFilter, 
  type UseEventStreamOptions, 
  type UseEventStreamReturn,
  type StreamMetrics,
} from "./use-event-stream";
