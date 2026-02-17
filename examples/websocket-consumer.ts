/**
 * WebSocket Event Stream Consumer Example
 * 
 * Issue #43: [API] WebSocket / Event Streaming API
 * 
 * This example demonstrates how to consume events from the 0xSCADA
 * WebSocket event stream with:
 * - Connection management
 * - Automatic reconnection
 * - Heartbeat handling
 * - Event filtering
 * - Error handling
 * 
 * Usage:
 *   npx tsx examples/websocket-consumer.ts
 *   npx tsx examples/websocket-consumer.ts --site site-001 --type ALARM
 */

import WebSocket from "ws";

// =============================================================================
// CONFIGURATION
// =============================================================================

interface ConsumerConfig {
  url: string;
  siteIds?: string[];
  assetIds?: string[];
  eventTypes?: string[];
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectBaseDelay: number;
  heartbeatInterval: number;
}

const DEFAULT_CONFIG: ConsumerConfig = {
  url: "ws://localhost:5000/ws/events",
  reconnect: true,
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1000,
  heartbeatInterval: 25000,
};

// =============================================================================
// TYPES
// =============================================================================

interface WebSocketMessage {
  type: string;
  payload?: unknown;
  timestamp: string;
}

interface EventPayload {
  eventType: string;
  siteId: string;
  assetId?: string;
  sourceTimestamp: string;
  originType: string;
  originId: string;
  payload: Record<string, unknown>;
  hash: string;
  details?: string;
}

interface ConnectionPayload {
  clientId: string;
  filter: {
    siteIds?: string[];
    assetIds?: string[];
    eventTypes?: string[];
  };
  serverTime: string;
}

interface MetricsPayload {
  totalConnections: number;
  activeConnections: number;
  totalMessagesSent: number;
  totalEventsStreamed: number;
  uptime: number;
}

// =============================================================================
// EVENT CONSUMER CLASS
// =============================================================================

class EventStreamConsumer {
  private config: ConsumerConfig;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private eventCount = 0;
  private isShuttingDown = false;

  constructor(config: Partial<ConsumerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build WebSocket URL with query parameters
   */
  private buildUrl(): string {
    const url = new URL(this.config.url);
    
    this.config.siteIds?.forEach((id) => url.searchParams.append("siteId", id));
    this.config.assetIds?.forEach((id) => url.searchParams.append("assetId", id));
    this.config.eventTypes?.forEach((type) => url.searchParams.append("eventType", type));
    
    return url.toString();
  }

  /**
   * Connect to the WebSocket server
   */
  connect(): void {
    if (this.isShuttingDown) return;

    const url = this.buildUrl();
    console.log(`🔌 Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason));
    this.ws.on("error", (error) => this.handleError(error));
    this.ws.on("pong", () => this.handlePong());
  }

  /**
   * Handle WebSocket open
   */
  private handleOpen(): void {
    console.log("✅ Connected to event stream");
    this.reconnectAttempts = 0;
    this.startHeartbeat();
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      this.processMessage(message);
    } catch (error) {
      console.error("Failed to parse message:", error);
    }
  }

  /**
   * Process message based on type
   */
  private processMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case "connected":
        this.handleConnected(message.payload as ConnectionPayload);
        break;
      case "event":
        this.handleEvent(message.payload as EventPayload);
        break;
      case "pong":
        // Heartbeat acknowledged
        break;
      case "subscribe":
        console.log("📋 Subscription updated:", message.payload);
        break;
      case "metrics":
        this.handleMetrics(message.payload as MetricsPayload);
        break;
      case "error":
        console.error("❌ Server error:", message.payload);
        break;
      default:
        console.log(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Handle connected message
   */
  private handleConnected(payload: ConnectionPayload): void {
    console.log(`📡 Client ID: ${payload.clientId}`);
    console.log(`   Server time: ${payload.serverTime}`);
    if (Object.keys(payload.filter).length > 0) {
      console.log(`   Active filter:`, payload.filter);
    }
  }

  /**
   * Handle event message
   */
  private handleEvent(event: EventPayload): void {
    this.eventCount++;
    
    const timestamp = new Date(event.sourceTimestamp).toLocaleTimeString();
    const type = event.eventType.padEnd(12);
    const site = event.siteId.padEnd(10);
    const asset = (event.assetId || "").padEnd(10);
    
    console.log(`[${timestamp}] ${type} | ${site} | ${asset} | ${event.details || ""}`);
    
    // Log every 100th event for progress
    if (this.eventCount % 100 === 0) {
      console.log(`📊 Total events received: ${this.eventCount}`);
    }
  }

  /**
   * Handle metrics response
   */
  private handleMetrics(metrics: MetricsPayload): void {
    console.log("\n📊 Server Metrics:");
    console.log(`   Active connections: ${metrics.activeConnections}`);
    console.log(`   Total connections: ${metrics.totalConnections}`);
    console.log(`   Events streamed: ${metrics.totalEventsStreamed}`);
    console.log(`   Uptime: ${Math.round(metrics.uptime / 1000 / 60)} minutes\n`);
  }

  /**
   * Handle WebSocket close
   */
  private handleClose(code: number, reason: Buffer): void {
    console.log(`📴 Connection closed (code: ${code}, reason: ${reason.toString() || "none"})`);
    this.stopHeartbeat();

    if (this.isShuttingDown) {
      console.log("👋 Shutdown complete");
      return;
    }

    if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      const delay = Math.min(
        this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
        30000
      );
      this.reconnectAttempts++;
      console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
      setTimeout(() => this.connect(), delay);
    } else if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error("❌ Max reconnection attempts reached");
      process.exit(1);
    }
  }

  /**
   * Handle WebSocket error
   */
  private handleError(error: Error): void {
    console.error("❌ WebSocket error:", error.message);
  }

  /**
   * Handle pong response
   */
  private handlePong(): void {
    // Server responded to our ping
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        // Also send application-level ping
        this.send({ type: "ping", timestamp: new Date().toISOString() });
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat interval
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Send a message to the server
   */
  send(message: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Update subscription filter
   */
  subscribe(filter: { siteIds?: string[]; assetIds?: string[]; eventTypes?: string[] }): void {
    this.send({
      type: "subscribe",
      payload: filter,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Request server metrics
   */
  requestMetrics(): void {
    this.send({ type: "metrics", timestamp: new Date().toISOString() });
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    console.log("\n🛑 Shutting down...");
    this.isShuttingDown = true;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, "Client shutdown");
    }
    
    console.log(`📊 Total events received: ${this.eventCount}`);
  }
}

// =============================================================================
// CLI INTERFACE
// =============================================================================

function parseArgs(): Partial<ConsumerConfig> {
  const args = process.argv.slice(2);
  const config: Partial<ConsumerConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
      case "-u":
        config.url = args[++i];
        break;
      case "--site":
      case "-s":
        config.siteIds = config.siteIds || [];
        config.siteIds.push(args[++i]);
        break;
      case "--asset":
      case "-a":
        config.assetIds = config.assetIds || [];
        config.assetIds.push(args[++i]);
        break;
      case "--type":
      case "-t":
        config.eventTypes = config.eventTypes || [];
        config.eventTypes.push(args[++i]);
        break;
      case "--no-reconnect":
        config.reconnect = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp(): void {
  console.log(`
0xSCADA WebSocket Event Stream Consumer

Usage: npx tsx examples/websocket-consumer.ts [options]

Options:
  -u, --url <url>       WebSocket URL (default: ws://localhost:5000/ws/events)
  -s, --site <id>       Filter by site ID (can be repeated)
  -a, --asset <id>      Filter by asset ID (can be repeated)
  -t, --type <type>     Filter by event type (can be repeated)
      --no-reconnect    Disable automatic reconnection
  -h, --help            Show this help

Event Types:
  TELEMETRY, ALARM, COMMAND, ACKNOWLEDGEMENT,
  MAINTENANCE, BLUEPRINT_CHANGE, CODE_GENERATION, DEPLOYMENT_INTENT

Examples:
  npx tsx examples/websocket-consumer.ts
  npx tsx examples/websocket-consumer.ts --site site-001 --type ALARM
  npx tsx examples/websocket-consumer.ts -s site-001 -s site-002 -t TELEMETRY -t ALARM
`);
}

// =============================================================================
// MAIN
// =============================================================================

function main(): void {
  const config = parseArgs();
  const consumer = new EventStreamConsumer(config);

  // Handle graceful shutdown
  process.on("SIGINT", () => consumer.shutdown());
  process.on("SIGTERM", () => consumer.shutdown());

  console.log("🚀 0xSCADA Event Stream Consumer");
  console.log("   Press Ctrl+C to exit\n");

  consumer.connect();

  // Request metrics every 30 seconds
  setInterval(() => {
    consumer.requestMetrics();
  }, 30000);
}

main();
