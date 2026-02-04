/**
 * Watch Command - Real-time event streaming via WebSocket
 *
 * Issue #92: [CLI] Add 'watch' command for real-time event streaming
 *
 * Features:
 * - WebSocket connection to server
 * - Colored output for different event types
 * - Timestamp formatting
 * - Filtering options (site, type, severity)
 * - Ctrl+C to stop
 * - Auto-reconnect on disconnect
 */

import { Command } from "commander";
import WebSocket from "ws";
import { loadConfig } from "../config.js";
import {
  colors,
  formatDate,
  outputError,
  outputInfo,
  outputWarning,
  setOutputOptions,
} from "../output.js";

// =============================================================================
// TYPES
// =============================================================================

interface WatchOptions {
  site?: string;
  type?: string;
  severity?: string;
  json?: boolean;
  color?: boolean;
  reconnect?: boolean;
}

interface EventMessage {
  type: "event" | "connected" | "subscribed" | "error" | "pong";
  payload?: EventPayload;
  subscriptionId?: string;
  event?: EventPayload;
  connectionId?: string;
  serverTime?: string;
  code?: string;
  message?: string;
  timestamp?: string;
}

interface EventPayload {
  eventType: string;
  siteId: string;
  assetId?: string;
  sourceTimestamp: string;
  originType: string;
  originId: string;
  payload: Record<string, unknown>;
  hash?: string;
  signature?: string;
  details?: string;
  severity?: string;
}

interface AssetStateChange {
  assetId: string;
  previousState?: string;
  newState: string;
  timestamp: string;
  siteId: string;
}

interface TagValue {
  tag: string;
  value: unknown;
  timestamp: string;
  quality?: string;
}

// =============================================================================
// WEBSOCKET CLIENT
// =============================================================================

class WatchClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private shouldReconnect: boolean;
  private options: WatchOptions;
  private isConnected = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private wsUrl: string;
  private filters: Record<string, string[]>;
  private onMessage: (msg: EventMessage) => void;
  private onClose: () => void;

  constructor(
    wsUrl: string,
    filters: Record<string, string[]>,
    options: WatchOptions,
    onMessage: (msg: EventMessage) => void,
    onClose: () => void
  ) {
    this.wsUrl = wsUrl;
    this.filters = filters;
    this.options = options;
    this.shouldReconnect = options.reconnect !== false;
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  connect(): void {
    // Build URL with query parameters for initial filter
    const url = new URL(this.wsUrl);
    if (this.filters.siteIds) {
      this.filters.siteIds.forEach(id => url.searchParams.append("siteId", id));
    }
    if (this.filters.eventTypes) {
      this.filters.eventTypes.forEach(type => url.searchParams.append("eventType", type));
    }

    try {
      this.ws = new WebSocket(url.toString());
    } catch (error) {
      outputError("Failed to create WebSocket connection", error instanceof Error ? error.message : "Unknown error");
      return;
    }

    this.ws.on("open", () => this.handleOpen());
    this.ws.on("message", (data) => this.handleMessage(data));
    this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    this.ws.on("error", (error) => this.handleError(error));
  }

  private handleOpen(): void {
    this.isConnected = true;
    this.reconnectAttempts = 0;

    if (!this.options.json) {
      console.log(colors.success("Connected to event stream"));
      console.log(colors.dim("Press Ctrl+C to stop watching"));
      console.log();
    }

    // Start ping interval to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 30000);

    // Subscribe with filters
    this.subscribe();
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = {
      type: "subscribe",
      filters: this.filters,
    };

    this.ws.send(JSON.stringify(subscribeMsg));
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message: EventMessage = JSON.parse(data.toString());
      this.onMessage(message);
    } catch (error) {
      if (!this.options.json) {
        outputWarning(`Failed to parse message: ${error}`);
      }
    }
  }

  private handleClose(code: number, reason: string): void {
    this.isConnected = false;
    this.clearPingInterval();

    if (!this.options.json) {
      console.log();
      console.log(colors.warning(`Disconnected (code: ${code}${reason ? `, reason: ${reason}` : ""})`));
    }

    if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.onClose();
    }
  }

  private handleError(error: Error): void {
    if (!this.options.json) {
      outputError("WebSocket error", error.message);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);

    if (!this.options.json) {
      console.log(colors.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`));
    }

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  close(): void {
    this.shouldReconnect = false;
    this.clearPingInterval();
    if (this.ws) {
      this.ws.close(1000, "Client closing");
      this.ws = null;
    }
  }
}

// =============================================================================
// OUTPUT FORMATTERS
// =============================================================================

function getEventColor(eventType: string): (text: string) => string {
  const type = eventType.toLowerCase();

  if (type.includes("alarm") || type.includes("error") || type.includes("fault")) {
    return colors.error;
  }
  if (type.includes("warning") || type.includes("alert")) {
    return colors.warning;
  }
  if (type.includes("maintenance") || type.includes("calibration")) {
    return colors.cyan;
  }
  if (type.includes("config") || type.includes("change")) {
    return colors.magenta;
  }
  return colors.info;
}

function getSeverityColor(severity?: string): (text: string) => string {
  if (!severity) return colors.dim;

  switch (severity.toLowerCase()) {
    case "critical":
    case "high":
      return colors.error;
    case "medium":
    case "warning":
      return colors.warning;
    case "low":
    case "info":
      return colors.info;
    default:
      return colors.dim;
  }
}

function formatEventOutput(event: EventPayload, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(event));
    return;
  }

  const timestamp = formatDate(event.sourceTimestamp);
  const colorFn = getEventColor(event.eventType);
  const severityColor = getSeverityColor(event.severity);

  // Format: [TIMESTAMP] [SITE] [TYPE] Message
  const parts: string[] = [
    colors.dim(`[${timestamp}]`),
    colors.cyan(`[${event.siteId}]`),
    colorFn(`[${event.eventType}]`),
  ];

  if (event.assetId) {
    parts.push(colors.bold(event.assetId));
  }

  if (event.severity) {
    parts.push(severityColor(`(${event.severity})`));
  }

  if (event.details) {
    parts.push(event.details);
  } else if (event.payload && Object.keys(event.payload).length > 0) {
    // Show abbreviated payload
    const payloadStr = JSON.stringify(event.payload);
    parts.push(colors.dim(payloadStr.length > 80 ? payloadStr.substring(0, 77) + "..." : payloadStr));
  }

  console.log(parts.join(" "));
}

function formatAssetStateOutput(change: AssetStateChange, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(change));
    return;
  }

  const timestamp = formatDate(change.timestamp);
  const arrow = colors.dim("->");

  console.log(
    `${colors.dim(`[${timestamp}]`)} ` +
    `${colors.cyan(`[${change.siteId}]`)} ` +
    `${colors.bold(change.assetId)} ` +
    `${colors.warning(change.previousState || "unknown")} ${arrow} ${colors.success(change.newState)}`
  );
}

function formatTagOutput(tag: TagValue, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(tag));
    return;
  }

  const timestamp = formatDate(tag.timestamp);
  const qualityIndicator = tag.quality === "good" ? colors.success("*") : colors.warning("!");

  console.log(
    `${colors.dim(`[${timestamp}]`)} ` +
    `${qualityIndicator} ` +
    `${colors.cyan(tag.tag)}: ` +
    `${colors.bold(String(tag.value))}`
  );
}

// =============================================================================
// COMMAND REGISTRATION
// =============================================================================

export function registerWatchCommand(program: Command): void {
  const watch = program
    .command("watch")
    .description("Watch real-time event streams via WebSocket");

  // Watch events
  watch
    .command("events")
    .description("Watch real-time events")
    .option("--site <siteId>", "Filter by site ID")
    .option("--type <eventType>", "Filter by event type (e.g., alarm, maintenance)")
    .option("--severity <level>", "Filter by severity (critical, high, medium, low)")
    .option("--no-reconnect", "Disable auto-reconnect on disconnect")
    .option("--json", "Output as JSON (one event per line)")
    .option("--no-color", "Disable colorized output")
    .action(async (options: WatchOptions) => {
      setOutputOptions({ json: options.json, color: options.color });
      await watchEvents(options);
    });

  // Watch asset state changes
  watch
    .command("assets")
    .description("Watch asset state changes")
    .option("--site <siteId>", "Filter by site ID")
    .option("--no-reconnect", "Disable auto-reconnect on disconnect")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options: WatchOptions) => {
      setOutputOptions({ json: options.json, color: options.color });
      await watchAssets(options);
    });

  // Watch specific tags
  watch
    .command("tags <tagList>")
    .description("Watch specific tag values (comma-separated list)")
    .option("--no-reconnect", "Disable auto-reconnect on disconnect")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (tagList: string, options: WatchOptions) => {
      setOutputOptions({ json: options.json, color: options.color });
      await watchTags(tagList, options);
    });
}

// =============================================================================
// WATCH IMPLEMENTATIONS
// =============================================================================

async function watchEvents(options: WatchOptions): Promise<void> {
  const config = loadConfig();
  const wsUrl = getWebSocketUrl(config.apiUrl, "/ws/events");

  // Build filters from options
  const filters: Record<string, string[]> = {};
  if (options.site) {
    filters.siteIds = [options.site];
  }
  if (options.type) {
    filters.eventTypes = [options.type];
  }

  if (!options.json) {
    outputInfo(`Connecting to ${wsUrl}...`);
    if (Object.keys(filters).length > 0) {
      console.log(colors.dim(`Filters: ${JSON.stringify(filters)}`));
    }
    console.log();
  }

  return new Promise<void>((resolve) => {
    const client = new WatchClient(
      wsUrl,
      filters,
      options,
      (message) => {
        if (message.type === "event" && message.event) {
          const event = message.event;

          // Apply severity filter client-side if specified
          if (options.severity && event.severity?.toLowerCase() !== options.severity.toLowerCase()) {
            return;
          }

          formatEventOutput(event, !!options.json);
        } else if (message.type === "connected" && !options.json) {
          outputInfo(`Connection ID: ${message.connectionId}`);
        } else if (message.type === "subscribed" && !options.json) {
          outputInfo(`Subscribed (ID: ${message.subscriptionId})`);
        } else if (message.type === "error" && !options.json) {
          outputError(`Server error: ${message.code}`, message.message);
        }
      },
      () => {
        if (!options.json) {
          console.log(colors.dim("Watch session ended."));
        }
        resolve();
      }
    );

    // Handle Ctrl+C
    const cleanup = () => {
      if (!options.json) {
        console.log();
        console.log(colors.dim("Stopping watch..."));
      }
      client.close();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    client.connect();
  });
}

async function watchAssets(options: WatchOptions): Promise<void> {
  const config = loadConfig();
  const wsUrl = getWebSocketUrl(config.apiUrl, "/ws/events");

  // Filter for asset state change events
  const filters: Record<string, string[]> = {
    eventTypes: ["asset_state_change", "state_change", "asset_update"],
  };
  if (options.site) {
    filters.siteIds = [options.site];
  }

  if (!options.json) {
    outputInfo(`Watching asset state changes...`);
    if (options.site) {
      console.log(colors.dim(`Site filter: ${options.site}`));
    }
    console.log();
  }

  return new Promise<void>((resolve) => {
    const client = new WatchClient(
      wsUrl,
      filters,
      options,
      (message) => {
        if (message.type === "event" && message.event) {
          const event = message.event;
          const stateChange: AssetStateChange = {
            assetId: event.assetId || event.originId,
            previousState: (event.payload.previousState as string) || undefined,
            newState: (event.payload.newState as string) || (event.payload.state as string) || "unknown",
            timestamp: event.sourceTimestamp,
            siteId: event.siteId,
          };
          formatAssetStateOutput(stateChange, !!options.json);
        } else if (message.type === "connected" && !options.json) {
          outputInfo(`Connected (ID: ${message.connectionId})`);
        } else if (message.type === "error" && !options.json) {
          outputError(`Server error: ${message.code}`, message.message);
        }
      },
      () => {
        if (!options.json) {
          console.log(colors.dim("Watch session ended."));
        }
        resolve();
      }
    );

    const cleanup = () => {
      if (!options.json) {
        console.log();
        console.log(colors.dim("Stopping watch..."));
      }
      client.close();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    client.connect();
  });
}

async function watchTags(tagList: string, options: WatchOptions): Promise<void> {
  const config = loadConfig();
  const wsUrl = getWebSocketUrl(config.apiUrl, "/ws/events");

  const tags = tagList.split(",").map(t => t.trim()).filter(t => t.length > 0);

  if (tags.length === 0) {
    outputError("No valid tags specified", "Provide comma-separated tag names");
    return;
  }

  // Filter for tag value events
  const filters: Record<string, string[]> = {
    eventTypes: ["tag_value", "tag_update", "sensor_reading"],
  };

  if (!options.json) {
    outputInfo(`Watching tags: ${tags.join(", ")}`);
    console.log();
  }

  return new Promise<void>((resolve) => {
    const client = new WatchClient(
      wsUrl,
      filters,
      options,
      (message) => {
        if (message.type === "event" && message.event) {
          const event = message.event;

          // Extract tag name from event
          const tagName = (event.payload.tag as string) ||
                         (event.payload.tagName as string) ||
                         event.assetId ||
                         event.originId;

          // Filter to only watched tags
          if (!tags.some(t => tagName.includes(t))) {
            return;
          }

          const tagValue: TagValue = {
            tag: tagName,
            value: event.payload.value ?? event.payload,
            timestamp: event.sourceTimestamp,
            quality: (event.payload.quality as string) || "good",
          };
          formatTagOutput(tagValue, !!options.json);
        } else if (message.type === "connected" && !options.json) {
          outputInfo(`Connected (ID: ${message.connectionId})`);
        } else if (message.type === "error" && !options.json) {
          outputError(`Server error: ${message.code}`, message.message);
        }
      },
      () => {
        if (!options.json) {
          console.log(colors.dim("Watch session ended."));
        }
        resolve();
      }
    );

    const cleanup = () => {
      if (!options.json) {
        console.log();
        console.log(colors.dim("Stopping watch..."));
      }
      client.close();
      resolve();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    client.connect();
  });
}

// =============================================================================
// HELPERS
// =============================================================================

function getWebSocketUrl(apiUrl: string, path: string): string {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}
