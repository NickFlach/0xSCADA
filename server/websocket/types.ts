/**
 * WebSocket Event Streaming Types
 * 
 * Issue #43: WebSocket / Event Streaming API
 * 
 * Message types for real-time event subscription and streaming.
 */

""

// =============================================================================
// CLIENT → SERVER MESSAGES
// =============================================================================

export interface SubscribeMessage {
  type: "subscribe";
  filters?: EventFilters;
  requestId?: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  subscriptionId?: string;
  requestId?: string;
}

export interface PingMessage {
  type: "ping";
  timestamp?: number;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage | PingMessage;

// =============================================================================
// SERVER → CLIENT MESSAGES
// =============================================================================

export interface ConnectedMessage {
  type: "connected";
  connectionId: string;
  serverTime: string;
  heartbeatIntervalMs: number;
}

export interface SubscribedMessage {
  type: "subscribed";
  subscriptionId: string;
  filters: EventFilters;
  requestId?: string;
}

export interface UnsubscribedMessage {
  type: "unsubscribed";
  subscriptionId?: string;
  requestId?: string;
}

export interface EventMessage {
  type: "event";
  subscriptionId: string;
  event: SerializedEvent;
  sequence: number;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
  serverTime: string;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface MetricsMessage {
  type: "metrics";
  connectionId: string;
  uptime: number;
  eventsReceived: number;
  subscriptionCount: number;
  lastEventTime?: string;
}

export type ServerMessage = 
  | ConnectedMessage 
  | SubscribedMessage 
  | UnsubscribedMessage
  | EventMessage 
  | PongMessage 
  | ErrorMessage
  | MetricsMessage;

// =============================================================================
// FILTERS & OPTIONS
// =============================================================================

export interface EventFilters {
  /** Filter by site ID(s) */
  siteIds?: string[];
  /** Filter by asset ID(s) */
  assetIds?: string[];
  /** Filter by event type(s) */
  eventTypes?: string[];
  /** Filter by origin type(s) */
  originTypes?: string[];
  /** Filter by severity levels */
  severities?: string[];
  /** Include events from before connection (requires cursor) */
  cursor?: string;
}

export interface ConnectionOptions {
  /** JWT token for authentication */
  token?: string;
  /** Initial filters (can also be set via query params) */
  filters?: EventFilters;
  /** Client identifier for logging */
  clientId?: string;
}

// =============================================================================
// INTERNAL TYPES
// =============================================================================

export interface WebSocketClient {
  id: string;
  ws: WebSocket | import("ws").WebSocket;
  userId?: string;
  authenticated: boolean;
  subscriptions: Map<string, Subscription>;
  connectedAt: Date;
  lastPingAt: Date;
  eventsReceived: number;
  sequence: number;
  clientInfo: {
    ip?: string;
    userAgent?: string;
    clientId?: string;
  };
}

export interface Subscription {
  id: string;
  filters: EventFilters;
  createdAt: Date;
  eventsMatched: number;
}

export interface SerializedEvent {
  eventType: string;
  siteId: string;
  assetId?: string;
  sourceTimestamp: string;
  originType: string;
  originId: string;
  payload: Record<string, unknown>;
  hash: string;
  signature: string;
  details?: string;
}

// =============================================================================
// ERROR CODES
// =============================================================================

export type ErrorCode = 
  | "INVALID_MESSAGE"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "UNAUTHORIZED"
  | "SUBSCRIPTION_LIMIT"
  | "RATE_LIMIT"
  | "INVALID_FILTER"
  | "INTERNAL_ERROR"
  | "CONNECTION_CLOSING";

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_MESSAGE: "Invalid message format",
  AUTHENTICATION_REQUIRED: "Authentication required",
  AUTHENTICATION_FAILED: "Authentication failed",
  UNAUTHORIZED: "Unauthorized access",
  SUBSCRIPTION_LIMIT: "Maximum subscription limit reached",
  RATE_LIMIT: "Rate limit exceeded",
  INVALID_FILTER: "Invalid filter parameters",
  INTERNAL_ERROR: "Internal server error",
  CONNECTION_CLOSING: "Connection is closing",
};

// =============================================================================
// METRICS
// =============================================================================

export interface WebSocketMetrics {
  activeConnections: number;
  totalConnections: number;
  authenticatedConnections: number;
  totalSubscriptions: number;
  totalEventsDelivered: number;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  uptime: number;
  startTime: Date;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface WebSocketServerConfig {
  /** Enable authentication requirement */
  requireAuth: boolean;
  /** Heartbeat/ping interval in ms */
  heartbeatIntervalMs: number;
  /** Connection timeout if no pong received in ms */
  connectionTimeoutMs: number;
  /** Maximum subscriptions per connection */
  maxSubscriptionsPerClient: number;
  /** Maximum connections per user */
  maxConnectionsPerUser: number;
  /** Maximum message size in bytes */
  maxMessageSize: number;
  /** Enable backpressure handling */
  enableBackpressure: boolean;
  /** Buffer size for backpressure (events) */
  backpressureBufferSize: number;
}

export const DEFAULT_CONFIG: WebSocketServerConfig = {
  requireAuth: false, // Start with false for development
  heartbeatIntervalMs: 30000,
  connectionTimeoutMs: 60000,
  maxSubscriptionsPerClient: 10,
  maxConnectionsPerUser: 5,
  maxMessageSize: 1024 * 64, // 64KB
  enableBackpressure: true,
  backpressureBufferSize: 1000,
};
